"""Render the designer's Load Demo payload through a real Home Assistant.

The designer previews templates with nunjucks (JavaScript); Home Assistant
renders them with Python Jinja. The two disagree on more than syntax: a
real send of the Load Demo payload failed on a live Home Assistant because
its ``progress_bar`` divided ``now().strftime('%S')`` -- a string -- by 60.
nunjucks coerced silently; HA raised ``TypeError: unsupported operand
type(s) for /: 'str' and 'int'``. Nothing in either repository rendered the
demo through Python, so the bug reached a display before anyone saw it
(fixed designer-side in odl-drawcustom-designer#196).

The vendored designer package ships its demo payload (``showcase.yml``) and
State Simulator seed (``showcase.json``) since designer 3.5.0
(``scripts/update-designer-vendor.py`` copies both into ``vendor/``). This
module renders that payload through the same template expansion, image
preload and ``generate_image`` call a real send uses, against the three
fabricated display geometries ``dev/inject-displays.py`` seeds. That is a
real send minus BLE delivery; what a physical panel's dither/palette makes
of the PNG is outside its reach.

Two of the tests document gaps rather than guard against them -- both are
open maintainer decisions, neither is settled here:

* ``test_whole_demo_renders_on_ha`` (strict xfail): the demo's ``dlimg``
  references ``/local/showcase.png``. The designer serves that from its own
  bundle; odl-renderer treats it as a filesystem path, which exists on no
  Home Assistant install.
* ``test_designer_only_variables_render_empty_in_ha``: ``{{ accent_color }}``
  and ``{{ alert }}`` are State Simulator *variables*, a designer-only
  concept; the send hands HA the raw YAML, so HA renders them as undefined.
"""

from dataclasses import replace
import io
import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.exceptions import ServiceValidationError
from odl_renderer.colors import WHITE, ColorResolver
from opendisplay import ColorScheme
from PIL import Image as PILImage
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
import yaml

from custom_components.opendisplay.designer.render import DESIGNER_RENDER_URL
from custom_components.opendisplay.services import render_payload_templates

from . import DEVICE_CONFIG

VENDOR_DIR = (
    Path(__file__).resolve().parent.parent
    / "custom_components"
    / "opendisplay"
    / "designer"
    / "frontend"
    / "vendor"
)

# The geometries dev/inject-displays.py seeds into a disposable HA, so the
# demo renders at every size and colour scheme a developer can see live.
# The first is also the conftest default (tests/__init__.py DEVICE_CONFIG).
_GEOMETRIES = {
    "296x128-BWR": (296, 128, ColorScheme.BWR),
    "200x200-MONO": (200, 200, ColorScheme.MONO),
    "800x480-BWRY": (800, 480, ColorScheme.BWRY),
}
_DEFAULT_GEOMETRY = "296x128-BWR"
_ALL_GEOMETRIES = pytest.mark.parametrize(
    "device_config", sorted(_GEOMETRIES), indirect=True, ids=sorted(_GEOMETRIES)
)


@pytest.fixture
def device_config(request):
    """Override the conftest device with one fabricated display geometry."""
    width, height, scheme = _GEOMETRIES[getattr(request, "param", _DEFAULT_GEOMETRY)]
    display = replace(
        DEVICE_CONFIG.displays[0],
        pixel_width=width,
        pixel_height=height,
        color_scheme=scheme.value,
    )
    return replace(DEVICE_CONFIG, displays=[display])


def _vendored(name: str) -> str:
    path = VENDOR_DIR / name
    assert path.is_file(), (
        f"{path} is missing -- the vendored designer predates the demo bundle; "
        "run scripts/update-designer-vendor.py --pin <version >= 3.5.0>"
    )
    return path.read_text("utf-8")


@pytest.fixture
def demo_payload() -> list[dict[str, Any]]:
    """Return the vendored Load Demo payload, exactly as the designer ships it."""
    payload = yaml.safe_load(_vendored("showcase.yml"))
    assert isinstance(payload, list)
    assert payload
    return payload


@pytest.fixture
def demo_simulator() -> dict[str, Any]:
    """Return the vendored State Simulator seed (states, attributes, variables)."""
    return json.loads(_vendored("showcase.json"))["simulator"]


@pytest.fixture
async def seeded_hass(hass, demo_simulator):
    """Seed hass with the demo's simulator states and attributes.

    This is the state the designer's own preview renders against. The
    seed's ``variables`` are deliberately NOT applied: HA has no such
    concept, and a real send does not carry them either (see
    test_designer_only_variables_render_empty_in_ha).
    """
    attributes = demo_simulator.get("attributes", {})
    for entity_id, state in demo_simulator["states"].items():
        hass.states.async_set(entity_id, state, attributes.get(entity_id))
    await hass.async_block_till_done()
    return hass


@pytest.fixture(autouse=True)
async def setup_entry(hass, mock_config_entry: MockConfigEntry) -> None:
    """Set up the config entry for the fabricated display."""
    mock_config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()


@pytest.fixture
def device_id(hass, mock_config_entry: MockConfigEntry) -> str:
    """Return the device registry ID for the fabricated display."""
    from homeassistant.helpers import device_registry as dr

    registry = dr.async_get(hass)
    devices = dr.async_entries_for_config_entry(registry, mock_config_entry.entry_id)
    assert devices
    return devices[0].id


async def _render(hass_client, device_id: str, payload: list[dict[str, Any]]):
    client = await hass_client()
    return await client.post(
        DESIGNER_RENDER_URL,
        json={"device_id": device_id, "payload": payload, "background": "white"},
    )


async def test_demo_templates_render_through_ha_jinja(seeded_hass, demo_payload):
    """Every demo template evaluates in HA's Python Jinja, not just in nunjucks.

    Calls the shared template expansion directly -- the one function both
    the send path and the render endpoint use -- so a failure names the
    element index, its type and Jinja's own reason, the way the live send
    did: ``drawcustom payload element 19 (type 'progress_bar') has an
    invalid template: TypeError: unsupported operand type(s) for /: 'str'
    and 'int'`` (designer 3.4.9's showcase).
    """
    try:
        rendered = render_payload_templates(seeded_hass, demo_payload)
    except ServiceValidationError as err:
        pytest.fail(str(err))
    assert len(rendered) == len(demo_payload)


@_ALL_GEOMETRIES
async def test_demo_elements_render_to_png_at_every_fabricated_geometry(
    seeded_hass, hass_client, device_id, demo_payload, device_config
):
    """Every demo element but the bundled image renders through odl-renderer.

    The render endpoint shares the send path's template expansion, local
    image preload and ``generate_image`` call, so this is a real send minus
    BLE delivery. The one ``dlimg`` is left out because it cannot render on
    any HA today -- ``test_whole_demo_renders_on_ha`` keeps that visible --
    and the exclusion is counted so a demo change does not widen it.
    """
    payload = [element for element in demo_payload if element["type"] != "dlimg"]
    assert len(payload) == len(demo_payload) - 1

    resp = await _render(hass_client, device_id, payload)

    if resp.status != 200:
        pytest.fail(f"render returned {resp.status}: {await resp.text()}")
    assert resp.content_type == "image/png"
    decoded = PILImage.open(io.BytesIO(await resp.read()))
    display = device_config.displays[0]
    assert decoded.size == (display.pixel_width, display.pixel_height)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "OPEN DECISION: the demo's dlimg url '/local/showcase.png' is served by "
        "the designer from its own bundle, but odl-renderer opens it as a "
        "filesystem path ('Image file not found: /local/showcase.png'), which "
        "no HA install has. Whether the designer rewrites the url before "
        "sending, the panel maps /local/ to <config>/www, or the send path "
        "does, is the maintainer's call. Strict: once any of those lands, this "
        "test flips and must become a plain assertion."
    ),
)
async def test_whole_demo_renders_on_ha(
    seeded_hass, hass_client, device_id, demo_payload
):
    """The demo exactly as Load Demo ships it, including the bundled image."""
    resp = await _render(hass_client, device_id, demo_payload)
    assert resp.status == 200, await resp.text()


async def test_designer_only_variables_render_empty_in_ha(
    seeded_hass, demo_payload, demo_simulator, caplog
):
    """Document what HA makes of the demo's State Simulator variables today.

    OPEN DECISION, not a guard: ``accent_color`` and ``alert`` live in
    showcase.json's ``simulator.variables``, a designer-only concept. The
    send hands HA the raw YAML, so HA renders them as undefined -- the
    accent fields come back as '' and the ``alert``-gated fill takes its
    else branch. odl-renderer then resolves '' as an unknown colour name and
    paints it WHITE, so on the white demo background the accent icon and
    the big title are invisible on the device while the preview shows them
    red. Whether the designer substitutes variables before ``onAction`` or
    the panel does is the maintainer's call; this test pins the current
    behaviour so that decision is made against evidence, and flips the day
    it is made.
    """
    variables = demo_simulator["variables"]
    assert variables == {"accent_color": "red", "alert": "true"}, (
        "the demo's variables changed -- re-derive the expectations below"
    )
    caplog.set_level(logging.WARNING, logger="homeassistant.helpers.template")

    rendered = render_payload_templates(seeded_hass, demo_payload)

    by_type = {}
    for source, out in zip(demo_payload, rendered, strict=True):
        for key, value in source.items():
            if isinstance(value, str) and "accent_color" in value:
                assert out[key] == "", f"{source['type']}.{key}"
                by_type.setdefault(source["type"], []).append(key)
            if isinstance(value, str) and "if alert" in value:
                assert out[key] == "white", f"{source['type']}.{key}"
                by_type.setdefault(source["type"], []).append(key)
    # The demo paints its icon fill and title colour with the accent variable
    # and gates one circle's fill on alert -- all three reach HA.
    assert by_type == {"icon": ["fill"], "text": ["color"], "circle": ["fill"]}
    warnings = [
        r.getMessage() for r in caplog.records if "is undefined" in r.getMessage()
    ]
    assert any("'accent_color' is undefined" in w for w in warnings)
    assert any("'alert' is undefined" in w for w in warnings)
    # ...and the empty colour is painted white, not the designer's red.
    assert ColorResolver().resolve("") == WHITE

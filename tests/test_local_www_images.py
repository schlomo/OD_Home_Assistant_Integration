"""`/local/<name>` image references resolve to `<config>/www/<name>`.

`/local/` is Home Assistant's HTTP-only alias for the `www` directory --
the way every HA user references a file they put there, in dashboards,
notifications and `image` entities alike. odl-renderer's `load_image` knows
nothing of it: a leading `/` is opened as a filesystem path, so a payload
with `url: /local/pic.png` failed every send and render with
``Image file not found: /local/pic.png`` (first seen when the designer's
Load Demo referenced its bundled image that way).

Both places that open a payload's image get the translation: the shared
local-image preload (send path and render endpoint, `services.py`) and the
designer's asset endpoint (`designer/asset.py`), so the canvas preview and
the device load the same `www` file for the same reference.

`..` after `/local/` must not leave `www`. HA's own static handler for
`/local/` never serves above `www`, and neither does this: a reference that
would escape is left exactly as written and fails as the literal path it
names -- never as a file outside `www`. The two escape tests here are
observable only against a naive join (`www / rest` without a containment
check): the escape targets are real images that a naive mapping WOULD
serve. Against the pre-mapping code they pass trivially, because the
literal `/local/...` path never existed; that is recorded in the PR.
"""

import io
from pathlib import Path
from typing import Any

from PIL import Image as PILImage
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.opendisplay.const import DOMAIN
from custom_components.opendisplay.designer.asset import DESIGNER_ASSET_URL
from custom_components.opendisplay.designer.render import DESIGNER_RENDER_URL
from custom_components.opendisplay.services import resolve_local_image_reference

_BLACK = (0, 0, 0)
_WHITE = (255, 255, 255)


@pytest.fixture
def www_dir(hass, tmp_path: Path) -> Path:
    """Point hass's config dir at a temp tree with a real `www/` in it.

    Core composes `allowlist_external_dirs` as `{<config>/www}` plus
    `media_dirs` plus the operator's own list; the asset endpoint reads that set, so the
    fixture mirrors the `www` half of it.
    """
    hass.config.config_dir = str(tmp_path)
    www = tmp_path / "www"
    www.mkdir()
    hass.config.allowlist_external_dirs = {str(www)}
    return www


@pytest.fixture
def media_dir(hass, tmp_path: Path, www_dir: Path) -> Path:
    """Add a second permitted root beside `www`, as a media dir would be."""
    media = tmp_path / "media"
    media.mkdir()
    hass.config.allowlist_external_dirs = {str(www_dir), str(media)}
    return media


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


def _png(path: Path, color: tuple[int, int, int] = _BLACK) -> bytes:
    """Write a solid 8x8 PNG and return its bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    PILImage.new("RGB", (8, 8), color).save(path, format="PNG")
    return path.read_bytes()


def _dlimg_payload(url: str) -> list[dict[str, Any]]:
    return [{"type": "dlimg", "x": 0, "y": 0, "url": url, "xsize": 8, "ysize": 8}]


async def _render_8x8(hass_client, url: str):
    client = await hass_client()
    return await client.post(
        DESIGNER_RENDER_URL,
        json={
            "display": {"width": 8, "height": 8},
            "payload": _dlimg_payload(url),
            "background": "white",
            "dither": "none",
        },
    )


async def _corner_pixel(resp) -> tuple[int, int, int]:
    image = PILImage.open(io.BytesIO(await resp.read())).convert("RGB")
    return image.getpixel((0, 0))


async def test_render_endpoint_loads_a_local_image_from_www(
    hass, hass_client, www_dir: Path
) -> None:
    """`url: /local/pic.png` renders `<config>/www/pic.png`.

    The probe is solid black over the whole 8x8 canvas, so a successful load
    is visible as a black corner pixel on the white background.
    """
    _png(www_dir / "pic.png")

    resp = await _render_8x8(hass_client, "/local/pic.png")

    assert resp.status == 200, await resp.text()
    assert await _corner_pixel(resp) == _BLACK


async def test_render_endpoint_loads_a_local_image_from_a_www_subdirectory(
    hass, hass_client, www_dir: Path
) -> None:
    """`/local/panels/kitchen.png` is `www/panels/kitchen.png`, like HA's own handler."""
    _png(www_dir / "panels" / "kitchen.png")

    resp = await _render_8x8(hass_client, "/local/panels/kitchen.png")

    assert resp.status == 200, await resp.text()
    assert await _corner_pixel(resp) == _BLACK


async def test_drawcustom_dry_run_loads_a_local_image_from_www(
    hass, device_id: str, www_dir: Path
) -> None:
    """The send path shares the preload, so a dry run of the same payload succeeds."""
    _png(www_dir / "pic.png")

    response = await hass.services.async_call(
        DOMAIN,
        "drawcustom",
        {
            "device_id": [device_id],
            "payload": _dlimg_payload("/local/pic.png"),
            "dry-run": True,
        },
        blocking=True,
        return_response=True,
    )

    assert response["status"] == "dry_run"


async def test_render_refuses_a_local_reference_escaping_www(
    hass, hass_client, www_dir: Path, tmp_path: Path
) -> None:
    """`/local/../escape.png` never reaches `<config>/escape.png`.

    The escape target is a real image a naive `www / rest` join would load
    and render black; the mapping leaves the reference as written, so the
    render fails the way the literal path always did.
    """
    _png(tmp_path / "escape.png")

    resp = await _render_8x8(hass_client, "/local/../escape.png")

    assert resp.status == 400
    assert "invalid payload" in (await resp.json())["message"]


async def test_asset_serves_a_local_image_from_www(
    hass, hass_client, www_dir: Path
) -> None:
    """The designer's canvas gets the same `www` file for the same reference."""
    expected = _png(www_dir / "pic.png")

    client = await hass_client()
    resp = await client.get(
        DESIGNER_ASSET_URL, params={"kind": "image", "name": "/local/pic.png"}
    )

    assert resp.status == 200, await resp.text()
    assert resp.content_type == "image/png"
    assert await resp.read() == expected


async def test_asset_refuses_a_local_symlink_leaving_www(
    hass, hass_client, www_dir: Path, media_dir: Path
) -> None:
    """`/local/link.png`, a symlink out of `www`, is not served even into a permitted root.

    `..` in the query string never reaches the view (aiohttp refuses it at
    the HTTP layer, see test_designer_asset.py), so the escape that can
    reach it is a symlink: `www/link.png -> media/escape.png`. `media` is a
    permitted root, so a naive `www / rest` join would resolve and serve
    it. The `/local/` alias must stay inside `www`, as HA's own static
    handler does; the reference is left as written and answers the same
    404 as any unresolvable path.
    """
    _png(media_dir / "escape.png")
    (www_dir / "link.png").symlink_to(media_dir / "escape.png")

    client = await hass_client()
    resp = await client.get(
        DESIGNER_ASSET_URL, params={"kind": "image", "name": "/local/link.png"}
    )

    assert resp.status == 404


def test_local_reference_escaping_www_is_left_as_written(tmp_path: Path) -> None:
    """The translation itself refuses `..`: the reference comes back untouched."""
    www = tmp_path / "www"
    www.mkdir()
    _png(tmp_path / "escape.png")

    assert resolve_local_image_reference(str(www), "/local/../escape.png") == (
        "/local/../escape.png"
    )
    assert resolve_local_image_reference(str(www), "/local/pic.png") == str(
        www / "pic.png"
    )
    assert resolve_local_image_reference(str(www), "/media/pic.png") == "/media/pic.png"

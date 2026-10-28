// Wrapper-level tests for opendisplay-designer-panel.js's `send` action and
// `renderPreview` seam: the REAL panel module, with the vendored designer
// bundle replaced by a stub `mount` through a `node:module` load hook and
// the few DOM globals the module touches at import time faked. What these
// prove: the `opendisplay.drawcustom` service call and the render-endpoint
// POST both receive LITERAL field values -- every template already
// rendered through HA's `render_template` websocket command with the
// designer's `context.variables` -- and a template failure aborts the
// send/preview with an error that names the element and field.
//
// Plain `node --test`, zero dependencies -- see key-containment.test.mjs's
// own header comment for why this repo tests panel JS this way.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The 5.6MB vendored designer expects a browser; the panel only needs its
// `mount` export to resolve. Only that one import is replaced -- js-yaml
// and every panel module under test load for real.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/vendor/odl-drawcustom-designer.js')) {
      return {
        format: 'module',
        source: 'export function mount() { throw new Error("stub mount: not for these tests"); }',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

class FakeElement {
  constructor() {
    this.style = {};
    this.isConnected = false;
    this.events = [];
  }
  dispatchEvent(event) {
    this.events.push(event);
    return true;
  }
}
globalThis.HTMLElement = FakeElement;
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
let PanelClass;
globalThis.customElements = {
  get: () => undefined,
  define: (_tag, cls) => {
    PanelClass = cls;
  },
};
await import('../../custom_components/opendisplay/designer/frontend/panel/opendisplay-designer-panel.js');
assert.ok(PanelClass, 'the panel registered its custom element');

const DEMO_CIRCLE_FILL = "{{ 'red' if alert else 'white' }}";
const PAYLOAD_YAML = `
- type: circle
  x: 20
  y: 20
  radius: 10
  fill: ${JSON.stringify(DEMO_CIRCLE_FILL)}
- type: text
  value: hello
  color: "{{ accent_color }}"
`;

/** A frozen designer context, `variables` included (designer >= the release carrying context.variables). */
function context(variables, targetId = 'dev1') {
  return Object.freeze({
    targetId,
    display: Object.freeze({ width: 296, height: 128, rotation: 0 }),
    render: Object.freeze({ dither: 0 }),
    ...(variables === undefined ? {} : { variables: Object.freeze(variables) }),
  });
}

/** `hass.connection.subscribeMessage` answering render_template from a table (an Error rejects). */
function fakeConnection(table) {
  const messages = [];
  return {
    messages,
    subscribeMessage(callback, message) {
      messages.push(message);
      const answer = table[message.template];
      if (answer instanceof Error) return Promise.reject(answer);
      queueMicrotask(() => callback({ result: answer, listeners: {} }));
      return Promise.resolve(() => {});
    },
  };
}

function panelWith({ table, fetchWithAuth }) {
  const panel = new PanelClass();
  const serviceCalls = [];
  panel._hass = {
    callService: async (...args) => {
      serviceCalls.push(args);
    },
    fetchWithAuth,
    connection: fakeConnection(table),
  };
  panel._targetDisplaySpecs = new Map([['dev1', { rotationDegrees: 0 }]]);
  return { panel, serviceCalls };
}

function notifications(panel) {
  return panel.events.filter((e) => e.type === 'hass-notification').map((e) => e.detail.message);
}

test('send: the service receives rendered literals, with context.variables as the template context', async () => {
  const { panel, serviceCalls } = panelWith({
    table: { [DEMO_CIRCLE_FILL]: 'red', '{{ accent_color }}': 'red' },
  });
  const variables = { alert: 'true', accent_color: 'red' };

  await panel._send(PAYLOAD_YAML, context(variables));

  assert.equal(serviceCalls.length, 1, `one service call; notifications: ${notifications(panel)}`);
  const [domain, service, data, target] = serviceCalls[0];
  assert.equal(domain, 'opendisplay');
  assert.equal(service, 'drawcustom');
  assert.deepEqual(target, { device_id: 'dev1' });
  assert.deepEqual(data.payload, [
    { type: 'circle', x: 20, y: 20, radius: 10, fill: 'red' },
    { type: 'text', value: 'hello', color: 'red' },
  ]);
  assert.deepEqual(data.device_id, ['dev1']);
  // Every render_template went out with the designer's variables, strict.
  assert.equal(panel._hass.connection.messages.length, 2);
  for (const message of panel._hass.connection.messages) {
    assert.equal(message.type, 'render_template');
    assert.deepEqual(message.variables, variables);
    assert.equal(message.strict, true);
  }
  assert.match(notifications(panel).at(-1), /^Sent 2 element\(s\)/);
});

test('send: a failing template aborts the call and the notification names element and field', async () => {
  const { panel, serviceCalls } = panelWith({
    table: {
      [DEMO_CIRCLE_FILL]: 'red',
      '{{ accent_color }}': new Error("UndefinedError: 'accent_color' is undefined"),
    },
  });

  await panel._send(PAYLOAD_YAML, context({ alert: 'true' }));

  assert.equal(serviceCalls.length, 0, 'the service must not be called with a half-rendered payload');
  assert.deepEqual(notifications(panel), [
    "Send failed: Element 1 (type 'text') field 'color' has an invalid template:" +
      " UndefinedError: 'accent_color' is undefined",
  ]);
  assert.equal(panel._sending, false, 'the in-flight guard is released');
});

test('send: a designer without context.variables still pre-renders, with {} as variables', async () => {
  const { panel, serviceCalls } = panelWith({
    table: { [DEMO_CIRCLE_FILL]: 'white', '{{ accent_color }}': '' },
  });

  await panel._send(PAYLOAD_YAML, context(undefined));

  assert.equal(serviceCalls.length, 1);
  assert.equal(serviceCalls[0][2].payload[0].fill, 'white');
  for (const message of panel._hass.connection.messages) assert.deepEqual(message.variables, {});
});

test('preview: the render endpoint receives the same rendered literals', async () => {
  const posts = [];
  const { panel } = panelWith({
    table: { [DEMO_CIRCLE_FILL]: 'red', '{{ accent_color }}': 'red' },
    fetchWithAuth: async (url, init) => {
      posts.push([url, JSON.parse(init.body)]);
      return { ok: true, blob: async () => 'png-bytes' };
    },
  });

  const blob = await panel._renderPreview(PAYLOAD_YAML, context({ alert: 'true', accent_color: 'red' }));

  assert.equal(blob, 'png-bytes');
  assert.equal(posts.length, 1);
  const [url, body] = posts[0];
  assert.equal(url, '/api/opendisplay/designer/render');
  assert.deepEqual(body.payload, [
    { type: 'circle', x: 20, y: 20, radius: 10, fill: 'red' },
    { type: 'text', value: 'hello', color: 'red' },
  ]);
  assert.equal(body.device_id, 'dev1');
});

test('preview: a failing template rejects before any POST, naming element and field', async () => {
  const posts = [];
  const { panel } = panelWith({
    table: { [DEMO_CIRCLE_FILL]: new Error("UndefinedError: 'alert' is undefined"), '{{ accent_color }}': 'red' },
    fetchWithAuth: async (url, init) => {
      posts.push([url, init]);
      return { ok: true, blob: async () => 'png-bytes' };
    },
  });

  await assert.rejects(panel._renderPreview(PAYLOAD_YAML, context({ accent_color: 'red' })), {
    message:
      "Element 0 (type 'circle') field 'fill' has an invalid template:" +
      " UndefinedError: 'alert' is undefined",
  });
  assert.equal(posts.length, 0);
});

test('send and preview without a websocket connection report the connection as unavailable', async () => {
  const { panel, serviceCalls } = panelWith({ table: {} });
  delete panel._hass.connection;

  await panel._send(PAYLOAD_YAML, context({}));
  assert.equal(serviceCalls.length, 0);
  assert.deepEqual(notifications(panel), ['Home Assistant connection unavailable']);
  await assert.rejects(panel._renderPreview(PAYLOAD_YAML, context({})), {
    message: 'Home Assistant connection unavailable',
  });
});

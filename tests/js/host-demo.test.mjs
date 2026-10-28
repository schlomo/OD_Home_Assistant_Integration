// Unit tests for loadHostDemoOptions / hostDemoUrls (host-demo.js): the
// panel hands the designer this integration's own Load Demo (frontend/demo/
// demo.yml + demo.json) through the `demo` mount option, and a failure to
// fetch it must fall back to the designer's bundled demo without breaking
// the mount. Plain `node --test`, zero dependencies -- see
// key-containment.test.mjs's own header comment for why this repo tests
// panel JS this way (the panel class itself imports the ~5.6MB vendored
// designer bundle and cannot be imported under `node --test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hostDemoUrls,
  loadHostDemoOptions,
} from '../../custom_components/opendisplay/designer/frontend/panel/host-demo.js';

const MODULE_URL =
  'https://ha.example/api/opendisplay/designer/static/panel/opendisplay-designer-panel.js?v=20260903a-123';
const PAYLOAD = '- type: text\n  value: hi\n';
const VARIABLES = { accent_color: 'red', alert: 'true' };

function okFetch(overrides = {}) {
  const bodies = {
    'demo.yml': { ok: true, status: 200, text: async () => PAYLOAD },
    'demo.json': {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ variables: VARIABLES }),
    },
    ...overrides,
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const name = String(url).split('/').pop();
    const res = bodies[name];
    if (res instanceof Error) throw res;
    return res;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function warnSpy() {
  const spy = (...args) => spy.calls.push(args);
  spy.calls = [];
  return spy;
}

test('the demo files live next to the panel module, served by the same static view', () => {
  const urls = hostDemoUrls(MODULE_URL);
  assert.equal(
    urls.payload.href,
    'https://ha.example/api/opendisplay/designer/static/demo/demo.yml'
  );
  assert.equal(
    urls.variables.href,
    'https://ha.example/api/opendisplay/designer/static/demo/demo.json'
  );
});

test('the loaded demo becomes the designer `demo` mount option, payload and variables', async () => {
  const warn = warnSpy();
  const options = await loadHostDemoOptions(MODULE_URL, okFetch(), warn);
  assert.deepEqual(options, { demo: { payload: PAYLOAD, variables: VARIABLES } });
  assert.deepEqual(warn.calls, []);
});

test('a fetch that rejects falls back to the bundled demo: no option, one warning, no throw', async () => {
  const warn = warnSpy();
  const fetchImpl = okFetch({ 'demo.yml': new Error('offline') });
  const options = await loadHostDemoOptions(MODULE_URL, fetchImpl, warn);
  assert.deepEqual(options, {});
  assert.equal(warn.calls.length, 1);
  assert.match(String(warn.calls[0].join(' ')), /offline/);
});

test('a non-2xx answer for either file falls back the same way', async () => {
  for (const name of ['demo.yml', 'demo.json']) {
    const warn = warnSpy();
    const fetchImpl = okFetch({ [name]: { ok: false, status: 404, text: async () => '' } });
    assert.deepEqual(await loadHostDemoOptions(MODULE_URL, fetchImpl, warn), {});
    assert.equal(warn.calls.length, 1, name);
    assert.match(String(warn.calls[0].join(' ')), /404/);
  }
});

test('a malformed variables file falls back rather than mounting a half demo', async () => {
  const cases = [
    'not json',
    JSON.stringify({ variables: 'red' }),
    JSON.stringify({ variables: { alert: true } }),
  ];
  for (const body of cases) {
    const warn = warnSpy();
    const fetchImpl = okFetch({
      'demo.json': { ok: true, status: 200, text: async () => body },
    });
    assert.deepEqual(await loadHostDemoOptions(MODULE_URL, fetchImpl, warn), {}, body);
    assert.equal(warn.calls.length, 1, body);
  }
});

test('an empty payload file falls back rather than offering an empty demo', async () => {
  const warn = warnSpy();
  const fetchImpl = okFetch({ 'demo.yml': { ok: true, status: 200, text: async () => '  \n' } });
  assert.deepEqual(await loadHostDemoOptions(MODULE_URL, fetchImpl, warn), {});
  assert.equal(warn.calls.length, 1);
});

test('a variables file without variables still yields the demo (variables are optional)', async () => {
  const warn = warnSpy();
  const fetchImpl = okFetch({
    'demo.json': { ok: true, status: 200, text: async () => '{}' },
  });
  assert.deepEqual(await loadHostDemoOptions(MODULE_URL, fetchImpl, warn), {
    demo: { payload: PAYLOAD },
  });
  assert.deepEqual(warn.calls, []);
});

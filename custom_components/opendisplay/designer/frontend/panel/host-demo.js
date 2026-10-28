/**
 * This integration's own Load Demo for the designer's `demo` mount option
 * (`MountOptions.demo`: `{ payload: string; variables?: Record<string,
 * string> }`).
 *
 * The designer's bundled showcase references entities a real Home
 * Assistant does not have (sensor.temperature, weather.forecast_home, …)
 * and a plot element that needs recorder history, so on a live install its
 * fields rendered "unknown" and Send failed. Home Assistant ships its own
 * demo instead -- `frontend/demo/demo.yml` (the payload) and `demo.json`
 * (its variables), the one copy both this panel and
 * `tests/test_designer_demo_render.py` read -- served by the same
 * unauthenticated static view as this module, so a plain `fetch` reaches
 * them and the browser revalidates them on every load (no `?v=` token:
 * the demo can change without the panel JS changing).
 *
 * A failure to load the demo must not break the mount: every failure path
 * returns `{}` (no `demo` key, the designer keeps its bundled demo) after
 * one warning, never a throw. The vendored designer predating the option
 * ignores an unknown `demo` key (its `mount()` reads known keys by name),
 * so passing it is safe before and after the vendor pin carries it.
 *
 * Pure of the panel class so `node --test` can import it (the panel itself
 * pulls in the ~5.6MB vendored bundle).
 */

const DEMO_PAYLOAD_FILE = '../demo/demo.yml';
const DEMO_VARIABLES_FILE = '../demo/demo.json';

/** The demo files' URLs, resolved next to the panel module (the `?v=` of the module's own URL does not carry over, by design). */
export function hostDemoUrls(moduleUrl) {
  return {
    payload: new URL(DEMO_PAYLOAD_FILE, moduleUrl),
    variables: new URL(DEMO_VARIABLES_FILE, moduleUrl),
  };
}

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function parseVariables(text, url) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${url} is not JSON: ${err?.message ?? err}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${url} must be a JSON object`);
  }
  if (parsed.variables === undefined) return undefined;
  const variables = parsed.variables;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new Error(`${url}: "variables" must be an object`);
  }
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value !== 'string') {
      throw new Error(`${url}: variable "${name}" must be a string`);
    }
  }
  return variables;
}

/**
 * Load the demo and return the mount-option fragment to spread into
 * `mount()`'s options: `{ demo: { payload, variables } }`, or `{}` after
 * one `warn(...)` call when either file cannot be fetched or parsed.
 */
export async function loadHostDemoOptions(
  moduleUrl,
  fetchImpl = globalThis.fetch,
  warn = console.warn
) {
  const urls = hostDemoUrls(moduleUrl);
  try {
    const [payload, variablesText] = await Promise.all([
      fetchText(fetchImpl, urls.payload),
      fetchText(fetchImpl, urls.variables),
    ]);
    if (!payload.trim()) throw new Error(`${urls.payload} is empty`);
    const variables = parseVariables(variablesText, urls.variables);
    return { demo: variables === undefined ? { payload } : { payload, variables } };
  } catch (err) {
    warn(
      "opendisplay-designer-panel: could not load the Home Assistant demo, Load Demo falls back to the designer's bundled one:",
      err?.message ?? err
    );
    return {};
  }
}

/**
 * Client-side template pre-rendering with the designer's Variables.
 *
 * The designer's shared Variables (its State Simulator "Variables", literal
 * strings, `context.variables` on both `onAction` and `renderPreview`) are
 * the analogue of an automation's script-level `variables:`. Home
 * Assistant's script engine renders a service call's data with those as
 * Jinja context -- `template.render_complex(data, variables)` -- BEFORE the
 * service handler ever runs; a service called directly has no such step.
 * This module is that step for the panel (maintainer decision 2026-10-27):
 * every string leaf carrying template syntax is rendered through HA's own
 * `render_template` websocket command with the variables, and the UNTOUCHED
 * `opendisplay.drawcustom` service (and the render endpoint) then receive
 * literal values, which `render_payload_templates` (services.py) passes
 * through unchanged. Send and preview call this identically, so what the
 * preview shows is what the display gets. `tests/test_designer_demo_render.py`
 * models the same procedure with HA's real `render_complex`.
 */

/** Mirror of HA's `homeassistant.helpers.template.is_template_string`. */
export function isTemplateString(value) {
  return value.includes('{{') || value.includes('{%') || value.includes('{#');
}

/** Render timeout handed to HA (seconds): a template still rendering after this is an error. */
const RENDER_TIMEOUT_SECONDS = 5;

/**
 * Renderer backed by HA's `render_template` websocket command.
 *
 * `render_template` is a SUBSCRIPTION that keeps re-rendering on every
 * state change the template touches; the panel wants exactly one answer,
 * so the first `result` event resolves and the subscription is dropped at
 * once. `strict` makes an undefined variable or a bad expression an error
 * instead of a silent partial render, like the script engine; `report_errors`
 * delivers a render failure as an `error` event rather than swallowing it.
 * A template whose very first strict render fails rejects the subscribe
 * itself (HA answers `send_error`), which rejects here too. The result is
 * whatever HA returns, natively typed (`parse_result`), like a service
 * call's own rendering.
 *
 * @param {{subscribeMessage: Function}} connection `hass.connection`.
 * @returns {(template: string, variables: object) => Promise<unknown>}
 */
export function haTemplateRenderer(connection) {
  return (template, variables) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = null;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        settle(value);
        // The first event can arrive before the subscribe promise has
        // handed over the unsubscribe function -- then it runs below.
        unsubscribe?.();
      };
      connection
        .subscribeMessage(
          (event) => {
            if (event && typeof event === 'object' && 'error' in event) {
              finish(reject, new Error(String(event.error)));
            } else {
              finish(resolve, event?.result);
            }
          },
          {
            type: 'render_template',
            template,
            variables,
            strict: true,
            report_errors: true,
            timeout: RENDER_TIMEOUT_SECONDS,
          }
        )
        .then(
          (unsub) => {
            unsubscribe = unsub;
            if (settled) unsubscribe();
          },
          (err) => finish(reject, err instanceof Error ? err : new Error(errorText(err)))
        );
    });
}

/** HA's websocket rejects with `{code, message}`; anything else is stringified. */
function errorText(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}

/**
 * Walk one value the way HA's `render_complex` does -- lists and dict
 * values recursively, template strings rendered, everything else returned
 * as is -- collecting one promise per template leaf so leaves render in
 * parallel (variables are literal strings, not templates, so no leaf
 * depends on another). `path` names the leaf for the error message.
 */
function walk(value, path, render, variables, failures) {
  if (typeof value === 'string') {
    if (!isTemplateString(value)) return value;
    return render(value, variables).catch((err) => {
      failures.push({ path, err });
      throw err;
    });
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item, i) => walk(item, `${path}[${i}]`, render, variables, failures)));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(async ([key, item]) => [
      key,
      await walk(item, path ? `${path}.${key}` : key, render, variables, failures),
    ]);
    return Promise.all(entries).then(Object.fromEntries);
  }
  return value;
}

/**
 * Pre-render a parsed drawcustom payload: a new elements array in which
 * every string leaf containing template syntax is replaced by its rendered
 * value and everything else is untouched.
 *
 * A failing leaf rejects with an `Error` naming the element index, its
 * `type` and the field path -- the shape the live send's own template
 * error uses (`services.py`'s `render_payload_templates`) -- and aborts
 * the whole send/preview: no half-rendered payload ever reaches HA.
 *
 * @param {unknown[]} elements Parsed payload (`parsePayload`).
 * @param {object|undefined} variables `context.variables`; absent before
 *   the designer release that carries it, treated as `{}`.
 * @param {(template: string, variables: object) => Promise<unknown>} render
 * @returns {Promise<unknown[]>}
 */
export async function prerenderElements(elements, variables, render) {
  const vars = variables ?? {};
  return Promise.all(
    elements.map(async (element, index) => {
      const failures = [];
      try {
        return await walk(element, '', render, vars, failures);
      } catch (err) {
        const type =
          element && typeof element === 'object' && !Array.isArray(element) ? (element.type ?? '?') : '?';
        const failure = failures[0] ?? { path: '', err };
        throw new Error(
          `Element ${index} (type '${type}') field '${failure.path}' has an invalid template: ` +
            errorText(failure.err)
        );
      }
    })
  );
}

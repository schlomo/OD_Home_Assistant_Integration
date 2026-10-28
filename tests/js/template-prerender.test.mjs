// Unit tests for template-prerender.js: the panel's client-side analogue of
// what Home Assistant's script engine does to an automation's service data
// before the handler runs (`template.render_complex(data, variables)`).
// The designer's shared Variables are the analogue of a script's
// `variables:`; the panel renders every templated field with them and then
// calls the untouched `opendisplay.drawcustom` service with literals.
//
// Plain `node --test`, zero dependencies -- see key-containment.test.mjs's
// own header comment for why this repo tests panel JS this way. The HA
// websocket is a fake `subscribeMessage` here; `render_template` is a
// SUBSCRIPTION (it keeps re-rendering on state changes), so the fake can
// deliver its events before or after the subscribe promise settles, and
// the tests pin that the first result wins and the subscription is dropped
// right after it either way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  haTemplateRenderer,
  isTemplateString,
  prerenderElements,
} from '../../custom_components/opendisplay/designer/frontend/panel/template-prerender.js';

/**
 * A fake `hass.connection` whose `render_template` answers from a lookup
 * table of template -> result, recording every message it was sent and
 * every unsubscribe. `deliver: 'before'` fires the first event before the
 * subscribe promise resolves (HA's real ordering: `send_result` then the
 * first `event` -- but the browser-side promise may settle either side of
 * the callback), `'after'` fires it on a later microtask.
 */
function fakeConnection(table, { deliver = 'after', extraResults = 0 } = {}) {
  const messages = [];
  const unsubscribed = [];
  const connection = {
    messages,
    unsubscribed,
    subscribeMessage(callback, message) {
      messages.push(message);
      const unsub = () => unsubscribed.push(message.template);
      const answer = table[message.template];
      const fire = () => {
        if (answer instanceof Error) {
          callback({ error: answer.message, level: 'ERROR' });
          return;
        }
        callback({ result: answer, listeners: {} });
        for (let i = 0; i < extraResults; i += 1) {
          callback({ result: `${answer}-again-${i}`, listeners: {} });
        }
      };
      if (answer === undefined) {
        // HA: a template that fails its first strict render rejects the
        // subscribe itself (`send_error`, `template_error`).
        return Promise.reject(new Error(`UndefinedError: '${message.template}' is undefined`));
      }
      if (deliver === 'before') {
        fire();
        return Promise.resolve(unsub);
      }
      return Promise.resolve().then(() => {
        queueMicrotask(fire);
        return unsub;
      });
    },
  };
  return connection;
}

test('isTemplateString mirrors HA is_template_string: {{, {% or {# anywhere', () => {
  assert.equal(isTemplateString('{{ alert }}'), true);
  assert.equal(isTemplateString('x {% if a %}y{% endif %}'), true);
  assert.equal(isTemplateString('{# comment #}'), true);
  assert.equal(isTemplateString('plain'), false);
  assert.equal(isTemplateString('{ not: template }'), false);
  assert.equal(isTemplateString(''), false);
});

test('every templated string leaf is rendered, nested dicts and lists walked, the rest untouched', async () => {
  const seen = [];
  const render = async (template, variables) => {
    seen.push([template, variables]);
    return `R(${template})`;
  };
  const elements = [
    {
      type: 'circle',
      fill: "{{ 'red' if alert else 'white' }}",
      x: 10,
      visible: true,
      label: 'static',
      nested: { color: '{{ accent_color }}', depth: { items: ['a', '{{ b }}', 3] } },
    },
    'bare {{ string }}',
  ];
  const variables = { alert: 'true', accent_color: 'red', b: '1' };

  const out = await prerenderElements(elements, variables, render);

  assert.deepEqual(out, [
    {
      type: 'circle',
      fill: "R({{ 'red' if alert else 'white' }})",
      x: 10,
      visible: true,
      label: 'static',
      nested: { color: 'R({{ accent_color }})', depth: { items: ['a', 'R({{ b }})', 3] } },
    },
    'R(bare {{ string }})',
  ]);
  // Only template strings reached the renderer, each with the variables.
  assert.deepEqual(
    seen.map(([t]) => t).sort(),
    ["{{ 'red' if alert else 'white' }}", '{{ accent_color }}', '{{ b }}', 'bare {{ string }}'].sort()
  );
  for (const [, vars] of seen) assert.equal(vars, variables);
  // Input is never mutated: the designer hands over its own parsed payload.
  assert.equal(elements[0].fill, "{{ 'red' if alert else 'white' }}");
  assert.equal(elements[0].nested.depth.items[1], '{{ b }}');
});

test('a payload with no templates comes back equal, with no renderer call at all', async () => {
  let calls = 0;
  const elements = [{ type: 'text', value: 'hi', size: 12, visible: true }];
  const out = await prerenderElements(elements, {}, async () => {
    calls += 1;
    return 'never';
  });
  assert.deepEqual(out, elements);
  assert.equal(calls, 0);
});

test('missing variables (designer before context.variables) are treated as {}', async () => {
  const seen = [];
  const out = await prerenderElements(
    [{ type: 'text', value: '{{ 1 + 1 }}' }],
    undefined,
    async (template, variables) => {
      seen.push(variables);
      return 2;
    }
  );
  assert.deepEqual(seen, [{}]);
  assert.deepEqual(out, [{ type: 'text', value: 2 }]);
});

test('a renderer failure surfaces as an Error naming element index, type and field path', async () => {
  const elements = [
    { type: 'text', value: 'fine' },
    { type: 'progress_bar', progress: "{{ now().strftime('%S') / 60 }}", style: { color: '{{ ok }}' } },
  ];
  const render = async (template) => {
    if (template.includes('strftime')) {
      throw new Error("TypeError: unsupported operand type(s) for /: 'str' and 'int'");
    }
    return 'red';
  };
  await assert.rejects(prerenderElements(elements, {}, render), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(
      err.message,
      "Element 1 (type 'progress_bar') field 'progress' has an invalid template:" +
        " TypeError: unsupported operand type(s) for /: 'str' and 'int'"
    );
    return true;
  });
});

test('a nested field failure names the full path into the element', async () => {
  const elements = [{ type: 'icon', style: { fills: ['{{ a }}', '{{ broken }}'] } }];
  const render = async (template) => {
    if (template === '{{ broken }}') throw new Error("UndefinedError: 'broken' is undefined");
    return 'x';
  };
  await assert.rejects(prerenderElements(elements, {}, render), {
    message:
      "Element 0 (type 'icon') field 'style.fills[1]' has an invalid template:" +
      " UndefinedError: 'broken' is undefined",
  });
});

test('haTemplateRenderer sends a strict, error-reporting render_template with the variables', async () => {
  const connection = fakeConnection({ '{{ alert }}': 'true' });
  const render = haTemplateRenderer(connection);
  const variables = { alert: 'true' };

  const result = await render('{{ alert }}', variables);

  assert.equal(result, 'true');
  assert.equal(connection.messages.length, 1);
  const message = connection.messages[0];
  assert.equal(message.type, 'render_template');
  assert.equal(message.template, '{{ alert }}');
  assert.equal(message.variables, variables);
  assert.equal(message.strict, true, 'strict: undefined variable = error, like the script engine');
  assert.equal(message.report_errors, true, 'report_errors: later failures arrive as error events');
  assert.ok(Number.isFinite(message.timeout) && message.timeout > 0, 'a render timeout is set');
});

test('haTemplateRenderer keeps the native-typed result HA returns', async () => {
  const connection = fakeConnection({ '{{ 1 + 1 }}': 2, '{{ false }}': false, '{{ [1,2] }}': [1, 2] });
  const render = haTemplateRenderer(connection);
  assert.equal(await render('{{ 1 + 1 }}', {}), 2);
  assert.equal(await render('{{ false }}', {}), false);
  assert.deepEqual(await render('{{ [1,2] }}', {}), [1, 2]);
});

for (const deliver of ['before', 'after']) {
  test(`haTemplateRenderer resolves with the FIRST result and unsubscribes (event ${deliver} subscribe settles)`, async () => {
    const connection = fakeConnection({ '{{ x }}': 'first' }, { deliver, extraResults: 2 });
    const render = haTemplateRenderer(connection);

    const result = await render('{{ x }}', {});
    // Let any extra events and the unsubscribe settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result, 'first');
    assert.deepEqual(connection.unsubscribed, ['{{ x }}'], 'the subscription is dropped exactly once');
  });
}

test('haTemplateRenderer rejects on an error event, with the error text', async () => {
  const connection = fakeConnection({
    '{{ 1 / 0 }}': new Error('ZeroDivisionError: division by zero'),
  });
  const render = haTemplateRenderer(connection);
  await assert.rejects(render('{{ 1 / 0 }}', {}), { message: 'ZeroDivisionError: division by zero' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(connection.unsubscribed, ['{{ 1 / 0 }}']);
});

test('haTemplateRenderer rejects when the subscribe itself fails (strict first-render error)', async () => {
  const connection = fakeConnection({});
  const render = haTemplateRenderer(connection);
  await assert.rejects(render('{{ nope }}', {}), { message: "UndefinedError: '{{ nope }}' is undefined" });
});

test('end to end: the Load Demo circle takes its truthy branch with alert = "true"', async () => {
  // The bug this module exists for: on a real display the demo's circle
  // rendered white because the designer's variables never reached HA.
  const connection = fakeConnection({ "{{ 'red' if alert else 'white' }}": 'red' });
  const out = await prerenderElements(
    [{ type: 'circle', fill: "{{ 'red' if alert else 'white' }}", x: 1, y: 1, radius: 5 }],
    { alert: 'true' },
    haTemplateRenderer(connection)
  );
  assert.equal(out[0].fill, 'red');
  assert.deepEqual(connection.messages[0].variables, { alert: 'true' });
});

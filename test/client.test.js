import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

test('fallback setting defaults off and saves the selected value', async () => {
  let snapshot = { status: 'ready', writable: true, revision: 1, value: {} };
  let operations;
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    async mutate(changes, revision) {
      assert.equal(revision, 1);
      operations = changes;
      snapshot = { ...snapshot, value: Object.fromEntries(changes.map((change) => [change.path[0], change.value])) };
      return true;
    },
  };
  const client = createClient({ configScope: scope });
  let tree = client.render();
  let checkbox = tree.children.find((child) => child?.type === 'label' && child.children.includes('预测失败时尝试会话模型')).children[0];
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  tree = client.render();
  checkbox = tree.children.find((child) => child?.type === 'label' && child.children.includes('预测失败时尝试会话模型')).children[0];
  assert.equal(checkbox.props.checked, true);
  const actions = tree.children.find((child) => child?.props?.className === 'dship-actions');
  await actions.children[0].props.onClick();
  assert.equal(operations.find((change) => change.path[0] === 'fallbackToSession').value, true);
  tree = client.render();
  checkbox = tree.children.find((child) => child?.type === 'label' && child.children.includes('预测失败时尝试会话模型')).children[0];
  assert.equal(checkbox.props.checked, true);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createClient({ lineTop = null, configScope = null, visibilityState = 'visible', reenterVisibility = false } = {}) {
  const hooks = [];
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const requests = [];
  const telemetry = [];
  const logs = [];
  const styles = [];
  let cursor = 0;
  let pending = [];
  let dirty = false;
  let nextTimer = 0;
  let now = 0;
  let component;
  let tree;
  let draft;
  const ghostElement = {
    style: {},
    getBoundingClientRect: () => ({ height: Number.parseFloat(ghostElement.style.maxHeight?.match(/, ([\d.]+)px\)$/)?.[1] || '200') }),
  };
  const editor = {
    innerText: '',
    lastElementChild: lineTop === null ? null : { getBoundingClientRect: () => ({ top: lineTop, height: 20 }) },
    getBoundingClientRect: () => ({ top: 100, left: 10, right: 510 }),
    querySelector: () => null,
    contains: (target) => target === editor,
    focus() { document.activeElement = editor; },
  };
  const properties = new Map();
  const card = {
    querySelector: () => editor,
    getBoundingClientRect: () => ({ top: 100, left: 0, right: 520 }),
    style: {
      getPropertyValue: (name) => properties.get(name),
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const anchor = { closest: () => card };
  const document = {
    visibilityState,
    head: { appendChild: (style) => styles.push(style) },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {} }),
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
  };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      if (props?.className === 'dship-anchor') props.ref.current = anchor;
      if (props?.className === 'dship-prediction') props.ref.current = ghostElement;
      return { type, props: props || {}, children };
    },
    useRef(value) {
      const index = cursor++;
      return hooks[index] ||= { current: value };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (!Object.is(hooks[index], next)) { hooks[index] = next; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        });
      }
    },
    useLayoutEffect(effect, deps) { React.useEffect(effect, deps); },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  const window = { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load({ factory }) {
    const plugin = factory((name) => { assert.equal(name, 'react'); return React; });
    plugin.apply({
      slots: { inject(_name, register) { register(); }, register(_options, value) { component = value; } },
      inject(_services, callback) {
        if (!configScope) return;
        callback({
          configForms: { get: () => configScope, whileServed: (_names, register) => register() },
          remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }, $on: () => () => {} },
          effect: (fn) => fn(),
          slots: { inject(_name, register) { register(); }, register(_options, value) { component = value; } },
        });
      },
    });
  } } };
  vm.runInNewContext(source, {
    window, document, AbortController,
    console: { info: (...args) => logs.push(args) },
    getComputedStyle: () => ({ paddingTop: '12px', paddingBottom: '12px', paddingLeft: '10px', paddingRight: '10px', maxHeight: '336px' }),
    fetch(url, options) {
      if (url === '/api/dsh-input-prediction/diagnostics') {
        telemetry.push({ url, options, body: JSON.parse(options.body) });
        return Promise.resolve({ ok: true });
      }
      const result = deferred();
      requests.push({ url, options, ...result });
      if (reenterVisibility) {
        reenterVisibility = false;
        listeners.get('visibilitychange')?.();
      }
      return result.promise;
    },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { const id = ++nextTimer; timeouts.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  });
  let props = { sessionId: 'first', locked: false, inputActions: { setDraft(value) { draft = value; } } };
  function render(nextProps = {}) {
    props = { ...props, ...nextProps };
    do {
      dirty = false;
      cursor = 0;
      pending = [];
      tree = component(configScope ? { view: 'page' } : props);
      if (configScope) tree = tree.type(tree.props);
      const effects = pending;
      pending = [];
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    render();
  }
  function tickPoll() {
    for (const { fn, ms } of intervals.values()) if (ms === 600) fn();
  }
  function respond(request, state) {
    request.resolve({ ok: true, json: async () => state });
  }
  function ghost() { return tree.children.find((child) => child?.props?.className === 'dship-prediction'); }
  function key(key) {
    const event = { key, target: editor, preventDefault() {}, stopPropagation() {} };
    listeners.get('keydown')?.(event);
  }
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timeouts) {
      if (timer.due <= now) { timeouts.delete(id); timer.fn(); }
    }
  }
  function event(type, extra = {}) {
    if (type === 'focusin') document.activeElement = extra.target || editor;
    if (type === 'focusout') document.activeElement = extra.relatedTarget || null;
    listeners.get(type)?.({ target: editor, relatedTarget: null, ...extra });
    render();
  }
  function setVisibility(value) {
    document.visibilityState = value;
    event('visibilitychange');
  }
  return { render, settle, tickPoll, advance, event, setVisibility, editor, requests, telemetry, logs, respond, ghost, key, styles, ghostElement, properties, intervals, get draft() { return draft; }, get activeElement() { return document.activeElement; } };
}

async function focusedPending() {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: '' });
  await client.settle();
  client.event('focusin');
  return client;
}

async function pollWith(client, state) {
  client.tickPoll();
  const request = client.requests.at(-1);
  client.respond(request, state);
  await client.settle();
}

test('diagnostics report changes without leaking input, prediction, or session', async () => {
  const client = createClient();
  client.render({ sessionId: 'private-session' });
  client.event('focusin');
  client.advance(3000);
  client.respond(client.requests[0], { status: 'pending', prediction: '' });
  await client.settle();
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '', reason: 'timeout' });
  assert.ok(client.logs.some(([label, detail]) => label.endsWith('idle') && detail.state === 'waiting-for-backend'));
  assert.ok(client.logs.some(([label, detail]) => label.endsWith('idle') && detail.state === 'requested'));
  await pollWith(client, { status: 'ready', completionSeq: 2, prediction: 'private-prediction', reason: 'ok' });
  assert.ok(client.logs.some(([label, detail]) => label.endsWith('display') && detail.visible));
  client.editor.innerText = 'private-input';
  client.event('input');
  assert.ok(client.logs.some(([label, detail]) => label.endsWith('display') && !detail.empty));
  assert.doesNotMatch(JSON.stringify(client.logs), /private-session|private-prediction|private-input/);
  assert.deepEqual(client.telemetry[0].body, { event: 'loaded', detail: {} });
  assert.ok(client.telemetry.some(({ body }) => body.event === 'idle' && body.detail.state === 'requested'));
  assert.ok(client.telemetry.some(({ body }) => body.event === 'backend' && body.detail.hasPrediction));
  assert.ok(client.telemetry.some(({ body }) => body.event === 'display' && body.detail.visible));
  assert.ok(client.telemetry.every(({ options }) => options.method === 'POST' && options.headers['Content-Type'] === 'application/json'));
  assert.doesNotMatch(JSON.stringify(client.telemetry), /private-session|private-prediction|private-input/);
});

test('poll diagnostics deduplicate repeated failures and report recovery', async () => {
  const client = createClient();
  client.render();
  client.requests[0].resolve({ ok: false, status: 503 });
  await client.settle();
  client.tickPoll();
  client.requests.at(-1).resolve({ ok: false, status: 503 });
  await client.settle();
  assert.equal(client.logs.filter(([label, detail]) => label.endsWith('poll') && detail.state === 'http-error').length, 1);
  client.tickPoll();
  client.requests.at(-1).reject(new Error('private network detail'));
  await client.settle();
  await pollWith(client, { status: 'ready', prediction: '', reason: 'timeout' });
  const pollStates = client.logs.filter(([label]) => label.endsWith('poll')).map(([, detail]) => detail.state);
  assert.deepEqual(pollStates, ['http-error', 'network-or-response-error', 'ok']);
  assert.ok(client.logs.some(([label, detail]) => label.endsWith('backend') && detail.reason === 'timeout'));
  assert.doesNotMatch(JSON.stringify(client.logs), /private network detail/);
  const pollEvents = client.telemetry.filter(({ body }) => body.event === 'poll');
  assert.deepEqual(pollEvents.map(({ body }) => body.detail.state), ['http-error', 'network-or-response-error', 'ok']);
  assert.equal(pollEvents[0].body.detail.status, 503);
  assert.doesNotMatch(JSON.stringify(client.telemetry), /private network detail/);
});

test('waits for slow pending prediction and retries an empty result once', async () => {
  const client = await focusedPending();
  client.advance(2999);
  assert.equal(client.requests.length, 1);
  client.advance(1);
  assert.equal(client.requests.length, 1);
  await pollWith(client, { status: 'pending', completionSeq: 1, prediction: '' });
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '' });
  assert.equal(client.requests.filter((r) => r.url.includes('trigger=focus-idle')).length, 1);
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '' });
  assert.equal(client.requests.filter((r) => r.url.includes('trigger=focus-idle')).length, 1);
});

test('waits for a slow first poll before deciding to trigger', async () => {
  const client = createClient();
  client.render();
  client.event('focusin');
  client.advance(3000);
  assert.equal(client.requests.length, 1);
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: '' });
  await client.settle();
  assert.equal(client.requests.length, 1);
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '' });
  assert.equal(client.requests.filter((r) => r.url.includes('trigger=focus-idle')).length, 1);
});

test('empty completed state triggers at three seconds and aborts on blur', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const request = client.requests.at(-1);
  assert.match(request.url, /trigger=focus-idle/);
  client.event('focusout');
  assert.equal(request.options.signal.aborted, true);
});

test('empty prediction is retried once per turn across refocus and input', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  assert.equal(retries().length, 1);
  client.event('focusout');
  client.event('focusin');
  client.advance(3000);
  assert.equal(retries().length, 1);
  client.event('input');
  client.advance(3000);
  assert.equal(retries().length, 1);
  client.render({ useSession: (selector) => selector({ running: true }) });
  client.render({ useSession: (selector) => selector({ running: false }) });
  client.respond(client.requests.at(-1), { status: 'ready', completionSeq: 2, prediction: '' });
  await client.settle();
  client.advance(3000);
  assert.equal(retries().length, 2);
});

test('a retry from none is tied to its completion and a new turn can retry none', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'none' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  assert.equal(retries().length, 1);
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '' });
  client.event('focusout');
  client.event('focusin');
  client.advance(3000);
  assert.equal(retries().length, 1);
  client.render({ useSession: (selector) => selector({ running: true }) });
  client.render({ useSession: (selector) => selector({ running: false }) });
  client.respond(client.requests.at(-1), { status: 'none' });
  await client.settle();
  client.advance(3000);
  assert.equal(retries().length, 2);
  client.render({ useSession: (selector) => selector({ running: true }) });
  client.render({ useSession: (selector) => selector({ running: false }) });
  client.respond(client.requests.at(-1), { status: 'none' });
  await client.settle();
  client.advance(3000);
  assert.equal(retries().length, 3);
});

test('session switch keeps the actual editor focus for the new session', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'first' });
  await client.settle();
  client.event('focusin');
  client.render({ sessionId: 'second' });
  client.respond(client.requests.at(-1), { status: 'ready', completionSeq: 2, prediction: '' });
  await client.settle();
  client.advance(3000);
  const retries = client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  assert.equal(retries.length, 1);
  assert.match(retries[0].url, /sessionId=second/);
});

test('pending prediction that succeeds does not trigger a retry', async () => {
  const client = await focusedPending();
  client.advance(3000);
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: 'success' });
  assert.equal(client.requests.filter((r) => r.url.includes('trigger=focus-idle')).length, 0);
  assert.equal(client.ghost().children[0].children[0], 'success');
});

test('blur, input, busy, and session switch cancel pending idle retry', async () => {
  for (const change of ['blur', 'input', 'busy', 'session']) {
    const client = await focusedPending();
    client.advance(3000);
    if (change === 'blur') client.event('focusout');
    if (change === 'input') { client.editor.innerText = 'draft'; client.event('input'); }
    if (change === 'busy') client.render({ useSession: (selector) => selector({ running: true }) });
    if (change === 'session') client.render({ sessionId: 'second' });
    if (change === 'busy') client.render({ useSession: (selector) => selector({ running: false }) });
    if (change === 'session' || change === 'busy') {
      client.respond(client.requests.at(-1), { status: 'ready', completionSeq: 1, prediction: '' });
      await client.settle();
    } else {
      await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '' });
    }
    assert.equal(client.requests.filter((r) => r.url.includes('trigger=focus-idle')).length, 0, change);
  }
});

test('multiline and wrapped preview uses the complete accepted text', async () => {
  const client = createClient();
  client.render();
  const prediction = Array.from({ length: 9 }, (_, index) => `line ${index} ${'wide '.repeat(30).trimEnd()}`).join('\n');
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction });
  await client.settle();
  assert.equal(client.ghost().children[0].children[0], prediction);
  assert.doesNotMatch(client.styles[0].textContent, /line-clamp|overflow:\s*hidden/);
  assert.match(client.styles[0].textContent, /overflow-y:\s*auto/);
  assert.match(client.styles[0].textContent, /pointer-events:\s*auto/);
  assert.equal(client.ghostElement.style.maxHeight, 'min(200px, 25vh, 200px)');
  assert.equal(client.properties.get('--dship-ghost-height'), '224px');
  client.key('Tab');
  assert.equal(client.draft, prediction);
});

test('preview preserves editor mouse behavior and focuses when clicked', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'suggestion' });
  await client.settle();
  let prevented = false;
  client.event('mousedown', { button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  client.ghost().props.onClick();
  assert.equal(client.activeElement, client.editor);
});

test('streams pending prefixes and accepts only the final prediction', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: 'Hel' });
  await client.settle();
  assert.equal(client.ghost().children[0].children[0], 'Hel');
  assert.equal(client.ghost().children[1], false);
  client.key('Tab');
  client.key('ArrowRight');
  assert.equal(client.draft, undefined);
  await pollWith(client, { status: 'pending', completionSeq: 1, prediction: 'Hello' });
  assert.equal(client.ghost().children[0].children[0], 'Hello');
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: 'Hello world' });
  assert.equal(client.ghost().children[0].children[0], 'Hello world');
  client.key('ArrowRight');
  assert.equal(client.draft, 'Hello world');
});

test('dismissal survives pending updates and completion but not a new turn', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: 'first' });
  await client.settle();
  client.key('Escape');
  client.render();
  await pollWith(client, { status: 'pending', completionSeq: 1 });
  await pollWith(client, { status: 'pending', completionSeq: 1, prediction: 'first more' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: 'first complete' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'pending', completionSeq: 2, prediction: 'second' });
  assert.equal(client.ghost().children[0].children[0], 'second');
});

test('terminal and failed polls clear a streamed preview', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: 'partial' });
  await client.settle();
  await pollWith(client, { status: 'none', reason: 'provider_error' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'pending', completionSeq: 2, prediction: 'partial again' });
  client.tickPoll();
  client.requests.at(-1).reject(new Error('network error'));
  await client.settle();
  assert.equal(client.ghost(), undefined);
});

test('preview stays within the editor height for a low caret', async () => {
  for (const [lineTop, expectedTop, expectedLimit] of [[350, '250px', '74px'], [420, '12px', '200px']]) {
    const client = createClient({ lineTop });
    client.render();
    client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'long\n'.repeat(100) });
    await client.settle();
    assert.equal(client.ghostElement.style.top, expectedTop);
    assert.equal(client.ghostElement.style.maxHeight, `min(200px, 25vh, ${expectedLimit})`);
    assert.ok(Number.parseFloat(client.properties.get('--dship-ghost-height')) <= 336);
  }
});

test('visibility pauses ordinary polls and ignores old responses after resuming', async () => {
  const client = createClient();
  client.render();
  const old = client.requests[0];
  client.setVisibility('hidden');
  assert.equal(old.options.signal.aborted, true);
  client.tickPoll();
  assert.equal(client.requests.length, 1);
  client.setVisibility('visible');
  client.setVisibility('visible');
  assert.equal(client.requests.length, 2);
  client.tickPoll();
  assert.equal(client.requests.length, 2);
  client.respond(client.requests[1], { status: 'ready', completionSeq: 2, prediction: 'new' });
  await client.settle();
  client.respond(old, { status: 'ready', completionSeq: 1, prediction: 'old' });
  await client.settle();
  assert.equal(client.ghost().children[0].children[0], 'new');
  client.tickPoll();
  assert.equal(client.requests.length, 3);
});

test('hidden mount and session or busy changes wait until visible', async () => {
  const client = createClient({ visibilityState: 'hidden' });
  client.render();
  client.render({ sessionId: 'second' });
  client.render({ useSession: (selector) => selector({ running: true }) });
  client.setVisibility('visible');
  assert.equal(client.requests.length, 0);
  client.render({ useSession: (selector) => selector({ running: false }) });
  assert.equal(client.requests.length, 1);
  assert.match(client.requests[0].url, /sessionId=second/);
  client.setVisibility('hidden');
  client.render({ sessionId: 'third' });
  client.setVisibility('visible');
  assert.equal(client.requests.length, 2);
  assert.match(client.requests[1].url, /sessionId=third/);
});

test('hiding does not cancel a focus-idle fallback', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'none' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const fallback = client.requests[1];
  assert.match(fallback.url, /trigger=focus-idle/);
  client.setVisibility('hidden');
  assert.equal(fallback.options.signal.aborted, false);
  client.tickPoll();
  assert.equal(client.requests.length, 2);
  client.setVisibility('visible');
  assert.equal(client.requests.length, 3);
  assert.equal(fallback.options.signal.aborted, false);
});

test('a waiting idle retry survives hiding and runs after the resumed poll', async () => {
  const client = createClient();
  client.render();
  client.event('focusin');
  client.advance(3000);
  client.setVisibility('hidden');
  client.respond(client.requests[0], { status: 'none' });
  await client.settle();
  assert.equal(client.requests.length, 1);
  client.setVisibility('visible');
  client.respond(client.requests[1], { status: 'none' });
  await client.settle();
  assert.equal(client.requests.length, 3);
  assert.match(client.requests[2].url, /trigger=focus-idle/);
});

test('synchronous visibility reentry keeps one poll and one draft timer', () => {
  const client = createClient({ reenterVisibility: true });
  client.render();
  assert.equal(client.requests.length, 1);
  assert.equal([...client.intervals.values()].filter(({ ms }) => ms === 600).length, 1);
  assert.equal([...client.intervals.values()].filter(({ ms }) => ms === 150).length, 1);
  client.setVisibility('hidden');
  assert.equal([...client.intervals.values()].filter(({ ms }) => ms === 600).length, 0);
  assert.equal([...client.intervals.values()].filter(({ ms }) => ms === 150).length, 1);
});

test('polls never overlap and recover after the response settles', async () => {
  const client = createClient();
  client.render();
  client.tickPoll();
  client.tickPoll();
  assert.equal(client.requests.length, 1);
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'first' });
  await client.settle();
  client.tickPoll();
  assert.equal(client.requests.length, 2);
  client.respond(client.requests[1], { status: 'none' });
  await client.settle();
  assert.equal(client.ghost(), undefined);
});

test('late responses after session or busy changes cannot replace current state', async () => {
  const client = createClient();
  client.render();
  const oldSession = client.requests[0];
  client.render({ sessionId: 'second' });
  assert.equal(oldSession.options.signal.aborted, true);
  const oldTurn = client.requests[1];
  client.render({ useSession: (selector) => selector({ running: true }) });
  assert.equal(oldTurn.options.signal.aborted, true);
  client.render({ useSession: (selector) => selector({ running: false }) });
  const latest = client.requests[2];
  client.respond(latest, { status: 'ready', completionSeq: 3, prediction: 'new' });
  await client.settle();
  client.respond(oldSession, { status: 'pending', completionSeq: 1, prediction: 'old session' });
  client.respond(oldTurn, { status: 'pending', completionSeq: 2, prediction: 'old turn' });
  await client.settle();
  assert.equal(client.ghost().children[0].children[0], 'new');
  client.key('Tab');
  assert.equal(client.draft, 'new');
});

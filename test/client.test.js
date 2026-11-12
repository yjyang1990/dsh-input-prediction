import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createClient({ lineTop = null } = {}) {
  const hooks = [];
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const requests = [];
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
    focus() {},
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
    useSyncExternalStore() {},
  };
  const window = { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load({ factory }) {
    const plugin = factory((name) => { assert.equal(name, 'react'); return React; });
    plugin.apply({
      slots: { inject(_name, register) { register(); }, register(_options, value) { component = value; } },
      inject() {},
    });
  } } };
  vm.runInNewContext(source, {
    window, document, AbortController,
    getComputedStyle: () => ({ paddingTop: '12px', paddingBottom: '12px', paddingLeft: '10px', paddingRight: '10px', maxHeight: '336px' }),
    fetch(url, options) {
      const result = deferred();
      requests.push({ url, options, ...result });
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
      tree = component(props);
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
    listeners.get(type)?.({ target: editor, relatedTarget: null, ...extra });
    render();
  }
  return { render, settle, tickPoll, advance, event, editor, requests, respond, ghost, key, styles, ghostElement, properties, get draft() { return draft; } };
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
  client.respond(oldSession, { status: 'ready', completionSeq: 1, prediction: 'old session' });
  client.respond(oldTurn, { status: 'none' });
  await client.settle();
  assert.equal(client.ghost().children[0].children[0], 'new');
  client.key('Tab');
  assert.equal(client.draft, 'new');
});

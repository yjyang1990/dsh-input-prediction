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
  const requests = [];
  const styles = [];
  let cursor = 0;
  let pending = [];
  let dirty = false;
  let nextTimer = 0;
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
    setTimeout() { return ++nextTimer; },
    clearTimeout() {},
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
  return { render, settle, tickPoll, requests, respond, ghost, key, styles, ghostElement, properties, get draft() { return draft; } };
}

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

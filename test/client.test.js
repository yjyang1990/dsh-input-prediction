import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

test('session menu targets the captured session and toggles its saved state', async () => {
  const contributions = [];
  let enabled = true;
  const requests = [];
  const window = { __ModuleLoader__: { load({ factory }) {
    const plugin = factory(() => ({}));
    plugin.apply({
      slots: { inject() {} },
      inject(services, callback) {
        if (services[0] === 'contextMenus') callback({
          effect: (fn) => fn(), contextMenus: { register(value) { contributions.push(value); return () => {}; } },
        });
      },
    });
  } } };
  vm.runInNewContext(source, { window, fetch: async (url, options) => {
    if (url === '/api/dsh-input-prediction/diagnostics') return { ok: true };
    requests.push({ url, options });
    return { ok: true, json: async () => ({ enabled }) };
  } });
  assert.deepEqual(contributions.map((contribution) => contribution.target), ['session', 'ds-bot.session']);
  for (const contribution of contributions) {
    enabled = true;
    requests.length = 0;
    const actions = await contribution.resolve({ sessionId: 'session A' }, new AbortController().signal);
    assert.equal(actions[0].label, '输入预测：已开启');
    await actions[0].run();
    assert.equal(requests[0].url, '/api/dsh-input-prediction/session-setting?sessionId=session%20A');
    assert.deepEqual(JSON.parse(requests[1].options.body), { sessionId: 'session A', enabled: false });
    enabled = false;
    const disabledActions = await contribution.resolve({ sessionId: 'session A' }, new AbortController().signal);
    assert.equal(disabledActions[0].label, '输入预测：已关闭');
    await disabledActions[0].run();
    assert.deepEqual(JSON.parse(requests[3].options.body), { sessionId: 'session A', enabled: true });
  }
});

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

test('timeout settings enforce the supported timer boundary', async () => {
  let operations;
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: {} }),
    async mutate(changes) { operations = changes; return true; },
  };
  const client = createClient({ configScope: scope });
  let tree = client.render();
  let field = tree.children.find((child) => child?.type === 'label' && child.children.includes('超时（秒）')).children[1];
  assert.equal(field.props.max, 2147483.647);
  field.props.onChange({ target: { value: '2147483.648' } });
  tree = client.render();
  await tree.children.find((child) => child?.props?.className === 'dship-actions').children[0].props.onClick();
  tree = client.render();
  assert.equal(operations, undefined);
  assert.ok(tree.children.find((child) => child?.props?.className === 'dship-actions').children[2].children[0].includes('2147483.647'));
  field = tree.children.find((child) => child?.type === 'label' && child.children.includes('超时（秒）')).children[1];
  field.props.onChange({ target: { value: '2147483.647' } });
  tree = client.render();
  await tree.children.find((child) => child?.props?.className === 'dship-actions').children[0].props.onClick();
  assert.equal(operations.find((change) => change.path[0] === 'timeoutMs').value, 2147483647);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function trackedChannels() {
  const channels = [];
  class TestChannel extends BroadcastChannel {
    constructor(name) { super(name); channels.push(this); }
    set onmessage(listener) {
      super.onmessage = (event) => { listener(event); this.onNextMessage?.(); };
    }
    nextMessage() { return new Promise((resolve) => { this.onNextMessage = resolve; }); }
    close() { this.closed = true; super.close(); }
  }
  return { channels, TestChannel };
}

function createClient({ lineTop = null, configScope = null, visibilityState = 'visible', reenterVisibility = false,
  settingEnabled = true, deferSettings = false, deferSettingPost = false, failSettingPost = false, broadcastChannel, sharedSettings } = {}) {
  const hooks = [];
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const requests = [];
  const settingRequests = [];
  const menus = [];
  const settings = sharedSettings || new Map();
  const pluginCleanups = [];
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
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
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
        if (_services[0] === 'contextMenus') {
          callback({ effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') pluginCleanups.push(cleanup); },
            contextMenus: { register(value) { menus.push(value); return () => {}; } } });
          return;
        }
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
    window, document, AbortController, URL, BroadcastChannel: broadcastChannel,
    console: { info: (...args) => logs.push(args) },
    getComputedStyle: () => ({ paddingTop: '12px', paddingBottom: '12px', paddingLeft: '10px', paddingRight: '10px', maxHeight: '336px' }),
    fetch(url, options) {
      if (url === '/api/dsh-input-prediction/diagnostics') {
        telemetry.push({ url, options, body: JSON.parse(options.body) });
        return Promise.resolve({ ok: true });
      }
      if (url.startsWith('/api/dsh-input-prediction/session-setting')) {
        if (options?.method === 'POST') {
          const { sessionId, enabled } = JSON.parse(options.body);
          if (!failSettingPost) settings.set(sessionId, enabled);
          const result = deferred();
          settingRequests.push({ url, options, ...result });
          return deferSettingPost ? result.promise : Promise.resolve({ ok: !failSettingPost });
        }
        const result = deferred();
        settingRequests.push({ url, options, ...result });
        if (deferSettings) return result.promise;
        const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId');
        const immediate = (value) => ({ then: (fn) => immediate(fn(value)), catch() { return this; } });
        return immediate({ ok: true, json: () => ({ enabled: settings.get(sessionId) ?? settingEnabled }) });
      }
      const result = deferred();
      requests.push({ url, options, ...result });
      if (reenterVisibility) {
        reenterVisibility = false;
        for (const handler of listeners.get('visibilitychange') || []) handler();
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
    for (const handler of listeners.get('keydown') || []) handler(event);
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
    for (const handler of listeners.get(type) || []) handler({ target: editor, relatedTarget: null, ...extra });
    render();
  }
  function setVisibility(value) {
    document.visibilityState = value;
    event('visibilitychange');
  }
  function openMenu(kind, sessionId) {
    const provider = menus.find((item) => item.target === kind);
    const target = { sessionId };
    const sources = provider.observe(target);
    let actions = [];
    let preparation;
    let controller;
    let preparations = 0;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      actions = [];
      preparations += 1;
      preparation = Promise.resolve(provider.resolve(target, signal)).then((value) => {
        if (!signal.aborted) actions = value;
      });
    };
    const unsubscribe = sources.map((source) => source.subscribe(refresh));
    const close = () => {
      controller?.abort();
      for (const release of unsubscribe.splice(0)) release();
    };
    pluginCleanups.push(close);
    refresh();
    return { close, get actions() { return actions; }, get ready() { return preparation; },
      get preparations() { return preparations; }, getSnapshot: sources[0].getSnapshot };
  }
  function unmount() {
    for (const hook of hooks) hook?.cleanup?.();
    for (const cleanup of pluginCleanups.reverse()) cleanup();
  }
  return { render, settle, tickPoll, advance, event, setVisibility, unmount, openMenu, editor, requests, settingRequests, settings, menus, telemetry, logs, respond, ghost, key, styles, ghostElement, properties, intervals, get draft() { return draft; }, get activeElement() { return document.activeElement; } };
}


test('default-off sessions only read settings until either menu enables prediction', async () => {
  for (const target of ['session', 'ds-bot.session']) {
    const client = createClient({ settingEnabled: false });
    client.render();
    client.event('focusin');
    client.advance(12000);
    client.tickPoll();
    assert.equal(client.settingRequests.length, 1);
    assert.equal(client.settingRequests[0].url, '/api/dsh-input-prediction/session-setting?sessionId=first');
    assert.equal(client.requests.length, 0);
    assert.equal(client.telemetry.length, 0);

    const menu = client.menus.find((item) => item.target === target);
    const [enable] = await menu.resolve({ sessionId: 'first' }, new AbortController().signal);
    assert.equal(enable.label, '输入预测：已关闭');
    await enable.run();
    client.render();
    assert.equal(client.requests.length, 1);
    client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
    await client.settle();
    client.advance(3000);
    const idle = client.requests.find((request) => request.url.includes('trigger=focus-idle'));
    assert.ok(idle);
    client.tickPoll();
    client.respond(client.requests.at(-1), { status: 'ready', completionSeq: 1, prediction: '预测文本' });
    await client.settle();
    assert.ok(client.ghost());
    client.tickPoll();
    const poll = client.requests.at(-1);

    const [disable] = await menu.resolve({ sessionId: 'first' }, new AbortController().signal);
    assert.equal(disable.label, '输入预测：已开启');
    await disable.run();
    assert.equal(idle.options.signal.aborted, true);
    assert.equal(poll.options.signal.aborted, true);
    client.render();
    assert.equal(client.ghost(), undefined);
    client.respond(poll, { status: 'ready', completionSeq: 2, prediction: '旧建议' });
    await client.settle();
    assert.equal(client.ghost(), undefined);
    const count = client.requests.length;
    const diagnosticCount = client.telemetry.length;
    client.event('focusout');
    client.event('focusin');
    client.advance(12000);
    client.tickPoll();
    assert.equal(client.requests.length, count);
    assert.equal(client.telemetry.length, diagnosticCount);
  }
});

test('session switches wait for their own setting and ignore old replies', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  const first = client.settingRequests[0];
  client.event('focusin');
  client.render({ sessionId: 'second' });
  const second = client.settingRequests[1];
  assert.equal(first.options.signal.aborted, true);
  client.respond(first, { enabled: true });
  await client.settle();
  client.advance(9000);
  assert.equal(client.requests.length, 0);
  client.respond(second, { enabled: false });
  await client.settle();
  assert.equal(client.requests.length, 0);

  client.render({ sessionId: 'first' });
  client.respond(client.settingRequests[2], { enabled: true });
  await client.settle();
  assert.equal(client.requests.length, 1);
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'first suggestion' });
  await client.settle();
  assert.ok(client.ghost());
  client.render({ sessionId: 'second' });
  assert.equal(client.ghost(), undefined);
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, 1);
  client.respond(client.settingRequests[3], { enabled: false });
  await client.settle();
  assert.equal(client.requests.length, 1);
});

test('updating another session does not enable the selected session', async () => {
  const client = createClient({ settingEnabled: false });
  client.render();
  const [enableOther] = await client.menus[1].resolve({ sessionId: 'second' }, new AbortController().signal);
  await enableOther.run();
  client.render();
  client.event('focusin');
  client.advance(9000);
  assert.equal(client.requests.length, 0);
  client.render({ sessionId: 'second' });
  assert.equal(client.requests.length, 1);
  assert.match(client.requests[0].url, /sessionId=second/);
  client.render({ sessionId: 'first' });
  assert.equal(client.requests[0].options.signal.aborted, true);
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, 1);
});

test('a successful menu update wins over an earlier settings read', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  const oldRead = client.settingRequests[0];
  const resolving = client.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
  client.respond(client.settingRequests[1], { enabled: false });
  const [enable] = await resolving;
  await enable.run();
  client.respond(client.settingRequests[3], { enabled: true });
  await client.settle();
  assert.equal(client.requests.length, 1);
  client.respond(oldRead, { enabled: false });
  await client.settle();
  assert.equal(client.requests[0].options.signal.aborted, false);
  assert.equal(client.intervals.size > 0, true);
});

test('disabling wins over an older read that reports enabled', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  const oldRead = client.settingRequests[0];
  const resolving = client.menus[1].resolve({ sessionId: 'first' }, new AbortController().signal);
  client.respond(client.settingRequests[1], { enabled: true });
  const [disable] = await resolving;
  await disable.run();
  client.respond(client.settingRequests[3], { enabled: false });
  await client.settle();
  client.respond(oldRead, { enabled: true });
  await client.settle();
  client.event('focusin');
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, 0);
});

test('a stale menu read follows newer menu updates and toggles the current state', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  client.respond(client.settingRequests[0], { enabled: false });
  await client.settle();
  const oldMenu = client.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
  const newMenu = client.menus[1].resolve({ sessionId: 'first' }, new AbortController().signal);
  client.respond(client.settingRequests[2], { enabled: false });
  const [enable] = await newMenu;
  await enable.run();
  client.respond(client.settingRequests[4], { enabled: true });
  await client.settle();
  const poll = client.requests[0];
  client.respond(client.settingRequests[1], { enabled: false });
  await client.settle();
  client.respond(client.settingRequests[5], { enabled: true });
  const [disable] = await oldMenu;
  assert.equal(disable.label, '输入预测：已开启');
  await disable.run();
  assert.equal(poll.options.signal.aborted, true);
  client.render();
  assert.equal(client.requests.length, 1);
});

test('a menu action opened before another change toggles the latest server setting', async () => {
  const client = createClient({ settingEnabled: false });
  client.render();
  const [oldAction] = await client.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
  const [enable] = await client.menus[1].resolve({ sessionId: 'first' }, new AbortController().signal);
  await enable.run();
  client.render();
  const poll = client.requests[0];
  assert.equal(client.settings.get('first'), true);
  await oldAction.run();
  assert.equal(client.settings.get('first'), false);
  assert.equal(poll.options.signal.aborted, true);
  client.render();
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, 1);
});

test('open native and bot menus refresh only for their session and detach on close or unload', async () => {
  const client = createClient({ settingEnabled: false });
  client.render();
  const native = client.openMenu('session', 'first');
  const bot = client.openMenu('ds-bot.session', 'first');
  const other = client.openMenu('session', 'other');
  await Promise.all([native.ready, bot.ready, other.ready]);
  assert.equal(native.actions[0].label, '输入预测：已关闭');
  assert.equal(bot.actions[0].label, '输入预测：已关闭');
  const previous = native.getSnapshot();
  const otherSnapshot = other.getSnapshot();

  await native.actions[0].run();
  await Promise.all([native.ready, bot.ready]);
  assert.equal(native.actions[0].label, '输入预测：已开启');
  assert.equal(bot.actions[0].label, '输入预测：已开启');
  assert.notEqual(native.getSnapshot(), previous);
  assert.equal(other.getSnapshot(), otherSnapshot);
  assert.equal(other.preparations, 1);

  await other.actions[0].run();
  await other.ready;
  assert.equal(other.actions[0].label, '输入预测：已开启');
  assert.equal(native.preparations, 2);
  assert.equal(bot.preparations, 2);

  native.close();
  await bot.actions[0].run();
  await bot.ready;
  assert.equal(bot.actions[0].label, '输入预测：已关闭');
  assert.equal(native.preparations, 2);
  assert.equal(other.preparations, 2);

  const actionAfterUnload = bot.actions[0];
  client.unmount();
  await actionAfterUnload.run();
  assert.equal(bot.preparations, 3);
  assert.equal(other.preparations, 2);
});

test('a refreshed menu hides the stale action while its setting read is pending', async () => {
  const client = createClient({ deferSettings: true });
  const native = client.openMenu('session', 'first');
  const bot = client.openMenu('ds-bot.session', 'first');
  client.respond(client.settingRequests[0], { enabled: false });
  client.respond(client.settingRequests[1], { enabled: false });
  await Promise.all([native.ready, bot.ready]);
  await bot.actions[0].run();
  assert.equal(native.actions.length, 0);
  assert.equal(bot.actions.length, 0);
  client.respond(client.settingRequests[3], { enabled: true });
  client.respond(client.settingRequests[4], { enabled: true });
  await Promise.all([native.ready, bot.ready]);
  assert.equal(native.actions[0].label, '输入预测：已开启');
  assert.equal(bot.actions[0].label, '输入预测：已开启');
  client.unmount();
});

test('an open menu in another window refreshes after broadcast', { timeout: 3000 }, async () => {
  const { channels, TestChannel } = trackedChannels();
  const sharedSettings = new Map();
  const first = createClient({ settingEnabled: false, sharedSettings, broadcastChannel: TestChannel });
  const second = createClient({ settingEnabled: false, sharedSettings, broadcastChannel: TestChannel });
  try {
    first.render();
    second.render();
    const native = first.openMenu('session', 'first');
    const bot = second.openMenu('ds-bot.session', 'first');
    const other = second.openMenu('session', 'other');
    await Promise.all([native.ready, bot.ready, other.ready]);
    assert.equal(bot.actions[0].label, '输入预测：已关闭');

    const secondNotified = channels[1].nextMessage();
    await native.actions[0].run();
    await secondNotified;
    await Promise.all([native.ready, bot.ready]);
    assert.equal(native.actions[0].label, '输入预测：已开启');
    assert.equal(bot.actions[0].label, '输入预测：已开启');
    assert.equal(other.preparations, 1);

    const firstNotified = channels[0].nextMessage();
    await bot.actions[0].run();
    await firstNotified;
    await Promise.all([native.ready, bot.ready]);
    assert.equal(native.actions[0].label, '输入预测：已关闭');
    assert.equal(bot.actions[0].label, '输入预测：已关闭');
    assert.equal(other.preparations, 1);
  } finally {
    first.unmount();
    second.unmount();
  }
});

test('settings failures keep prediction disabled and failed saves do not notify it', async () => {
  const failedRead = createClient({ deferSettings: true });
  failedRead.render();
  failedRead.settingRequests[0].reject(new Error('settings unavailable'));
  await failedRead.settle();
  failedRead.event('focusin');
  failedRead.advance(9000);
  failedRead.tickPoll();
  assert.equal(failedRead.requests.length, 0);

  const failedRefresh = createClient({ deferSettings: true });
  failedRefresh.render();
  failedRefresh.respond(failedRefresh.settingRequests[0], { enabled: true });
  await failedRefresh.settle();
  failedRefresh.setVisibility('hidden');
  failedRefresh.setVisibility('visible');
  failedRefresh.settingRequests[1].reject(new Error('settings unavailable'));
  await failedRefresh.settle();
  failedRefresh.event('focusin');
  failedRefresh.advance(9000);
  failedRefresh.tickPoll();
  assert.equal(failedRefresh.requests.length, 1);
  assert.equal(failedRefresh.requests[0].options.signal.aborted, true);

  const failedSave = createClient({ settingEnabled: false, failSettingPost: true });
  failedSave.render();
  const failedMenu = failedSave.openMenu('session', 'first');
  await failedMenu.ready;
  await assert.rejects(failedMenu.actions[0].run(), /保存输入预测设置失败/);
  assert.equal(failedMenu.preparations, 1);
  failedSave.render();
  failedSave.event('focusin');
  failedSave.advance(9000);
  failedSave.tickPoll();
  assert.equal(failedSave.requests.length, 0);
  failedSave.unmount();
});

test('visible windows synchronize successful menu changes and discard stale reads', { timeout: 3000 }, async () => {
  const { channels, TestChannel } = trackedChannels();
  const sharedSettings = new Map();
  const first = createClient({ settingEnabled: false, sharedSettings, broadcastChannel: TestChannel });
  const second = createClient({ deferSettings: true, sharedSettings, broadcastChannel: TestChannel });
  const other = createClient({ settingEnabled: false, sharedSettings, broadcastChannel: TestChannel });
  let secondUnmounted = false;
  try {
    first.render();
    second.render();
    other.render({ sessionId: 'other' });
    const staleRead = second.settingRequests[0];
    const secondEnabled = channels[1].nextMessage();
    const otherEnabled = channels[2].nextMessage();
    const [enable] = await first.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
    await enable.run();
    await Promise.all([secondEnabled, otherEnabled]);
    second.respond(second.settingRequests[1], { enabled: true });
    await second.settle();
    other.render();
    assert.equal(staleRead.options.signal.aborted, true);
    assert.equal(second.requests.length, 1);
    assert.equal(other.requests.length, 0);
    second.respond(staleRead, { enabled: false });
    await second.settle();
    assert.equal(second.requests[0].options.signal.aborted, false);
    second.respond(second.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
    await second.settle();
    second.event('focusin');
    second.advance(3000);
    const idle = second.requests.at(-1);
    assert.match(idle.url, /trigger=focus-idle/);
    second.tickPoll();
    second.respond(second.requests.at(-1), { status: 'ready', completionSeq: 1, prediction: 'window suggestion' });
    await second.settle();
    assert.ok(second.ghost());
    second.tickPoll();
    const pending = second.requests.at(-1);
    const secondDisabled = channels[1].nextMessage();
    const otherDisabled = channels[2].nextMessage();
    const [disable] = await first.menus[1].resolve({ sessionId: 'first' }, new AbortController().signal);
    await disable.run();
    await Promise.all([secondDisabled, otherDisabled]);
    assert.equal(pending.options.signal.aborted, true);
    assert.equal(idle.options.signal.aborted, true);
    second.respond(second.settingRequests[2], { enabled: false });
    await second.settle();
    assert.equal(second.ghost(), undefined);
    second.event('focusin');
    second.advance(12000);
    second.tickPoll();
    assert.equal(second.requests.length, 4);
    assert.equal(other.requests.length, 0);

    second.unmount();
    secondUnmounted = true;
    assert.equal(channels[1].closed, true);
    const otherReceived = channels[2].nextMessage();
    const [reenable] = await first.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
    await reenable.run();
    await otherReceived;
    assert.equal(second.requests.length, 4);
  } finally {
    first.unmount();
    if (!secondUnmounted) second.unmount();
    other.unmount();
  }
  assert.ok(channels.every((channel) => channel.closed));
});

test('a delayed older POST and its broadcast do not restore a later disabled setting', { timeout: 3000 }, async () => {
  const { channels, TestChannel } = trackedChannels();
  const sharedSettings = new Map();
  const first = createClient({ settingEnabled: false, deferSettingPost: true, sharedSettings, broadcastChannel: TestChannel });
  const second = createClient({ settingEnabled: false, sharedSettings, broadcastChannel: TestChannel });
  try {
    first.render();
    second.render();
    const [enable] = await first.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
    const pendingEnable = enable.run();
    const oldPost = first.settingRequests.at(-1);
    assert.equal(JSON.parse(oldPost.options.body).enabled, true);
    assert.equal(sharedSettings.get('first'), true);

    second.setVisibility('hidden');
    second.setVisibility('visible');
    assert.equal(second.requests.length, 1);
    second.respond(second.requests[0], { status: 'ready', completionSeq: 1, prediction: 'old suggestion' });
    await second.settle();
    assert.ok(second.ghost());
    second.tickPoll();
    const pendingPoll = second.requests.at(-1);

    const firstNotified = channels[0].nextMessage();
    const [disable] = await second.menus[1].resolve({ sessionId: 'first' }, new AbortController().signal);
    await disable.run();
    assert.equal(pendingPoll.options.signal.aborted, true);
    second.render();
    assert.equal(second.ghost(), undefined);
    assert.equal(sharedSettings.get('first'), false);
    await firstNotified;
    first.render();
    assert.equal(first.requests.length, 0);

    const secondNotified = channels[1].nextMessage();
    oldPost.resolve({ ok: true });
    await pendingEnable;
    await secondNotified;
    first.render();
    second.render();
    first.event('focusin');
    second.event('focusin');
    first.advance(12000);
    second.advance(12000);
    first.tickPoll();
    second.tickPoll();
    assert.equal(first.requests.length, 0);
    assert.equal(second.requests.length, 2);
    assert.equal(second.ghost(), undefined);
    assert.equal(sharedSettings.get('first'), false);
  } finally {
    first.unmount();
    second.unmount();
  }
});

test('a failed setting read retries while visible and resumes only after a successful read', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  client.event('focusin');
  client.settingRequests[0].reject(new Error('temporarily unavailable'));
  await client.settle();
  client.advance(4999);
  assert.equal(client.settingRequests.length, 1);
  assert.equal(client.requests.length, 0);
  client.advance(1);
  assert.equal(client.settingRequests.length, 2);
  client.respond(client.settingRequests[1], { enabled: true });
  await client.settle();
  assert.equal(client.requests.length, 1);
  client.unmount();
});

test('a successful menu update cancels a scheduled setting retry', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  client.settingRequests[0].reject(new Error('temporarily unavailable'));
  await client.settle();
  const resolving = client.menus[0].resolve({ sessionId: 'first' }, new AbortController().signal);
  client.respond(client.settingRequests[1], { enabled: false });
  const [enable] = await resolving;
  await enable.run();
  client.respond(client.settingRequests[3], { enabled: true });
  await client.settle();
  assert.equal(client.requests.length, 1);
  client.advance(5000);
  assert.equal(client.settingRequests.length, 4);
  client.unmount();
});

test('setting retries stop when hidden, changing session, or unmounting', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  client.settingRequests[0].reject(new Error('temporarily unavailable'));
  await client.settle();
  client.setVisibility('hidden');
  client.advance(5000);
  assert.equal(client.settingRequests.length, 1);
  client.setVisibility('visible');
  assert.equal(client.settingRequests.length, 2);
  client.settingRequests[1].reject(new Error('still unavailable'));
  await client.settle();
  client.render({ sessionId: 'second' });
  assert.equal(client.settingRequests.length, 3);
  client.advance(5000);
  assert.equal(client.settingRequests.length, 3);
  client.settingRequests[2].reject(new Error('still unavailable'));
  await client.settle();
  client.unmount();
  client.advance(5000);
  assert.equal(client.settingRequests.length, 3);
  assert.equal(client.requests.length, 0);
});

test('visibility restore refreshes settings changed by another window', async () => {
  const client = createClient({ settingEnabled: false });
  client.render();
  client.event('focusin');
  client.settings.set('first', true);
  client.setVisibility('hidden');
  client.setVisibility('visible');
  assert.equal(client.requests.length, 1);
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'visible' });
  await client.settle();
  assert.ok(client.ghost());
  client.settings.set('first', false);
  client.setVisibility('hidden');
  client.setVisibility('visible');
  assert.equal(client.ghost(), undefined);
  const count = client.requests.length;
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, count);
  assert.equal(client.settingRequests.filter((request) => !request.options?.method).length, 3);
});

test('visibility waits for the latest setting before restarting requests', async () => {
  const client = createClient({ deferSettings: true });
  client.render();
  client.respond(client.settingRequests[0], { enabled: true });
  await client.settle();
  client.event('focusin');
  assert.equal(client.requests.length, 1);
  client.setVisibility('hidden');
  client.setVisibility('visible');
  assert.equal(client.requests[0].options.signal.aborted, true);
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, 1);
  client.respond(client.settingRequests[1], { enabled: false });
  await client.settle();
  assert.equal(client.requests.length, 1);

  client.setVisibility('hidden');
  client.setVisibility('visible');
  client.respond(client.settingRequests[2], { enabled: true });
  await client.settle();
  assert.equal(client.requests.length, 2);
  client.setVisibility('hidden');
  client.setVisibility('visible');
  const earlier = client.settingRequests[3];
  client.setVisibility('hidden');
  client.setVisibility('visible');
  const later = client.settingRequests[4];
  assert.equal(earlier.options.signal.aborted, true);
  client.respond(later, { enabled: false });
  await client.settle();
  client.respond(earlier, { enabled: true });
  await client.settle();
  client.advance(9000);
  client.tickPoll();
  assert.equal(client.requests.length, 2);
});

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

test('announces only complete, focused predictions and clears on dismissal', async () => {
  const client = await focusedPending();
  const announcement = () => client.render().children.find((child) => child?.props?.className === 'dship-announcement');
  assert.equal(announcement().props['aria-live'], 'polite');
  await pollWith(client, { status: 'pending', completionSeq: 1, prediction: '部分' });
  assert.equal(announcement().children[0], '');
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '继续测试' });
  assert.equal(announcement().children[0], '输入预测：继续测试。按 Tab 或向右方向键接受，按 Escape 忽略。');
  assert.equal(client.ghost().props['aria-hidden'], true);
  client.event('focusout');
  assert.equal(announcement().children[0], '');
  client.event('focusin');
  assert.ok(announcement().children[0].includes('继续测试'));
  client.key('Escape');
  assert.equal(announcement().children[0], '');
});

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

test('retries once after transport failure while focus stays unchanged', async () => {
  for (const failure of ['network', 'http']) {
    const client = createClient();
    client.render();
    client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
    await client.settle();
    client.event('focusin');
    const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
    client.advance(2999);
    assert.equal(retries().length, 0, failure);
    client.advance(1);
    assert.equal(retries().length, 1, failure);
    if (failure === 'network') retries()[0].reject(new Error('network failed'));
    else retries()[0].resolve({ ok: false, status: 503 });
    await client.settle();
    client.advance(2999);
    assert.equal(retries().length, 1, failure);
    client.advance(1);
    assert.equal(retries().length, 2, failure);
    if (failure === 'network') retries()[1].reject(new Error('network failed again'));
    else retries()[1].resolve({ ok: false, status: 503 });
    await client.settle();
    client.advance(12000);
    await client.settle();
    assert.equal(retries().length, 2, failure);
    assert.equal(client.activeElement, client.editor, failure);
  }
});

test('cancels scheduled transport retry on blur or session change', async () => {
  for (const change of ['blur', 'session']) {
    const client = createClient();
    client.render();
    client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
    await client.settle();
    client.event('focusin');
    client.advance(3000);
    const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
    retries()[0].reject(new Error('network failed'));
    await client.settle();
    if (change === 'blur') client.event('focusout');
    else {
      client.render({ sessionId: 'second' });
      client.respond(client.requests.at(-1), { status: 'ready', completionSeq: 2, prediction: 'present' });
      await client.settle();
    }
    client.advance(3000);
    assert.equal(retries().length, 1, change);
  }
});

test('skips scheduled transport retry if a prediction arrives', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  retries()[0].reject(new Error('network failed'));
  await client.settle();
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: 'present' });
  client.advance(3000);
  assert.equal(retries().length, 1);
});

test('pauses a scheduled idle request while hidden and restarts the delay when visible', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
  await client.settle();
  client.event('focusin');
  const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  client.advance(1000);
  client.setVisibility('hidden');
  client.advance(10000);
  assert.equal(retries().length, 0);
  client.setVisibility('visible');
  client.advance(2999);
  assert.equal(retries().length, 0);
  client.advance(1);
  assert.equal(retries().length, 1);
  assert.equal(client.activeElement, client.editor);
});

test('pauses a transport retry while hidden without resetting the retry limit', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  retries()[0].reject(new Error('network failed'));
  await client.settle();
  client.setVisibility('hidden');
  client.advance(10000);
  assert.equal(retries().length, 1);
  client.setVisibility('visible');
  client.advance(2999);
  assert.equal(retries().length, 1);
  client.advance(1);
  assert.equal(retries().length, 2);
  retries()[1].reject(new Error('network failed again'));
  await client.settle();
  client.advance(10000);
  assert.equal(retries().length, 2);
});

test('transport failures allow another idle retry in the same turn', async () => {
  for (const failure of ['network', 'http']) {
    const client = createClient();
    client.render();
    client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: '' });
    await client.settle();
    client.event('focusin');
    client.advance(3000);
    const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
    assert.equal(retries().length, 1);
    if (failure === 'network') retries()[0].reject(new Error('network failed'));
    else retries()[0].resolve({ ok: false, status: 503 });
    await client.settle();
    client.event('focusout');
    client.event('focusin');
    client.advance(3000);
    assert.equal(retries().length, 2, failure);
    retries()[1].resolve({ ok: true });
    await client.settle();
    client.event('focusout');
    client.event('focusin');
    client.advance(3000);
    assert.equal(retries().length, 2, failure);
  }
});

test('failed idle request releases a turn learned while it was in flight', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'none' });
  await client.settle();
  client.event('focusin');
  client.advance(3000);
  const retries = () => client.requests.filter((request) => request.url.includes('trigger=focus-idle'));
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: '' });
  retries()[0].reject(new Error('network failed'));
  await client.settle();
  client.event('focusout');
  client.event('focusin');
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
  const predictionStyle = client.styles[0].textContent.match(/\.dship-prediction \{([^}]*)\}/)[1];
  assert.doesNotMatch(predictionStyle, /line-clamp|overflow:\s*hidden/);
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

test('hides pending prefixes and displays only the complete prediction', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: 'Hel' });
  await client.settle();
  assert.equal(client.ghost(), undefined);
  client.key('Tab');
  client.key('ArrowRight');
  assert.equal(client.draft, undefined);
  await pollWith(client, { status: 'pending', completionSeq: 1, prediction: 'Hello' });
  assert.equal(client.ghost(), undefined);
  client.key('Escape');
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: 'Hello world' });
  assert.equal(client.ghost().children[0].children[0], 'Hello world');
  client.key('ArrowRight');
  assert.equal(client.draft, 'Hello world');
});

test('dismissal survives pending updates and completion but not a new turn', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'ready', completionSeq: 1, prediction: 'first' });
  await client.settle();
  client.key('Escape');
  client.render();
  await pollWith(client, { status: 'pending', completionSeq: 1 });
  await pollWith(client, { status: 'pending', completionSeq: 1, prediction: 'first more' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'ready', completionSeq: 1, prediction: 'first complete' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'pending', completionSeq: 2, prediction: 'second' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'ready', completionSeq: 2, prediction: 'second complete' });
  assert.equal(client.ghost().children[0].children[0], 'second complete');
});

test('terminal and failed polls keep incomplete predictions hidden', async () => {
  const client = createClient();
  client.render();
  client.respond(client.requests[0], { status: 'pending', completionSeq: 1, prediction: 'partial' });
  await client.settle();
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'none', reason: 'provider_error' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'pending', completionSeq: 2, prediction: 'partial again' });
  assert.equal(client.ghost(), undefined);
  await pollWith(client, { status: 'ready', completionSeq: 2, prediction: '', reason: 'invalid_json' });
  assert.equal(client.ghost(), undefined);
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

test('a waiting idle retry restarts its delay after the resumed poll', async () => {
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
  assert.equal(client.requests.length, 2);
  client.advance(2999);
  assert.equal(client.requests.length, 2);
  client.advance(1);
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

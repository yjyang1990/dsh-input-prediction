import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../lib/index.js";

const text = (value) => [{ type: "text", text: value }];
const userMessage = (value, kind = "user") => ({ role: "user", content: text(value), source: { kind } });
const assistantMessage = (value) => ({ role: "assistant", content: text(value) });

function completedEvents(reason = "completed") {
  return [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "assistant/message", seq: 2, data: {} },
    { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: reason } } },
  ];
}

// The plugin keeps predictions in module state; give every session its own id.
let nextSession = 0;

function makeSession(overrides = {}) {
  nextSession += 1;
  return {
    id: `s${nextSession}`,
    header: {},
    events: completedEvents(),
    messages: [
      userMessage("RULES ".repeat(5000), "agent-instructions"),
      userMessage("SKILLS ".repeat(5000), "skill-catalog"),
      userMessage("2026-10-24 12:00", "time-context"),
      userMessage("帮我把默认错误码改成 10000"),
      assistantMessage("已修改，还没有运行测试。"),
    ],
    route: { provider: "chat", model: "big", reasoningEffort: "high" },
    ...overrides,
    snapshotEvents() { return this.events; },
    deriveMessages() { return this.messages; },
    toolHistory() { return this.tools ? { tools: this.tools, updates: [] } : undefined; },
    requestHeader() { return { config: this.route, ...(this.tools ? { tools: this.tools } : {}) }; },
  };
}

function makeHost({ catalog = {}, reply = '{"suggestion":"继续运行测试"}', stream, resolveModel } = {}) {
  const calls = [];
  const warnings = [];
  const infos = [];
  const listeners = {};
  const cleanups = [];
  let route;
  const routes = new Map();
  let lastSession;
  const sessions = new Map();
  const ctx = {
    on(name, listener) { listeners[name] = listener; },
    effect(setup) { cleanups.push(setup()); },
    logger: { warn: (...args) => warnings.push(args.join(" ")), info: (...args) => infos.push(args.join(" ")) },
    connection: { fetch: { register(definition) { routes.set(definition.path, definition); if (definition.path === "/api/dsh-input-prediction") route = definition; } } },
    sessions: { get: (id) => sessions.get(id) },
    sessionProjections: { stateOf: () => undefined },
    llm: {
      listProviders: () => Object.keys(catalog).map((id) => ({ id })),
      listModels: async (provider) => (catalog[provider] || []).map((id) => ({ id })),
      async resolveModelInfo(provider, model) {
        if (resolveModel) return resolveModel(provider, model);
        if (!(catalog[provider] || []).includes(model)) throw new Error("unknown route");
        return { provider, id: model };
      },
      async prepareCall(config, signal, configure) {
        const controls = configure ? configure({}, { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "high" }] } }) : {};
        const call = { config: { ...config, ...controls }, messages: undefined, options: undefined, signal: undefined };
        calls.push(call);
        return {
          config: call.config,
          stream(options) {
            call.messages = options.messages;
            call.options = options;
            call.signal = options.signal;
            return stream ? stream(options) : (async function* () {
              yield { type: "text-delta", text: reply };
              yield { type: "finish", reason: { kind: "stop" } };
            })();
          },
        };
      },
    },
  };
  return {
    ctx,
    calls,
    warnings,
    infos,
    routes,
    add(session) { lastSession = session.id; sessions.set(session.id, session); },
    // A live turn/end or explicit focus-idle request starts a prediction.
    end(session) { listeners["session/event"]?.(session, session.events.at(-1)); },
    emit: (name, ...args) => listeners[name]?.(...args),
    dispose() { for (const cleanup of cleanups) cleanup?.(); },
    async poll(sessionId = lastSession) {
      const response = await route.fetch(new Request(`http://local/api/dsh-input-prediction?sessionId=${sessionId}`));
      return response.json();
    },
    async triggerFocusIdle(sessionId = lastSession) {
      const response = await route.fetch(new Request(`http://local/api/dsh-input-prediction?sessionId=${sessionId}&trigger=focus-idle`));
      return response.json();
    },
  };
}

async function settle(host, session) {
  if (session) host.end(session);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sessionId = session?.id;
  for (let i = 0; i < 100; i += 1) {
    const state = await host.poll(sessionId);
    if (state.status !== "pending") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("prediction stayed pending");
}

test("streams only decoded suggestion prefixes across chunk boundaries", async () => {
  let send;
  let consumed;
  const host = makeHost({ stream: async function* () {
    while (true) {
      const chunk = await new Promise((resolve) => { send = resolve; });
      if (chunk === null) return;
      yield { type: "text-delta", text: chunk };
      consumed();
    }
  } });
  const session = makeSession();
  host.add(session);
  apply(host.ctx);
  host.end(session);
  await new Promise((resolve) => setTimeout(resolve, 0));
  async function push(chunk, prediction) {
    const done = new Promise((resolve) => { consumed = resolve; });
    send(chunk);
    await done;
    const state = await host.poll();
    assert.equal(state.status, "pending");
    assert.equal(state.prediction, prediction);
  }
  await push('{"sug', "");
  await push('gestion":"  你', "你");
  await push('好\\', "你好");
  await push('"\\uD83D', '你好"');
  await push('\\uDE00', '你好"😀');
  await push('\\n世界', '你好"😀\n世界');
  await push('"}', '你好"😀\n世界');
  send(null);
  const state = await settle(host);
  assert.equal(state.prediction, '你好"😀\n世界');
  assert.equal(state.status, "ready");
});

test("streams suggestion prefixes inside a split Markdown JSON fence", async () => {
  let send;
  let consumed;
  const host = makeHost({ stream: async function* () {
    while (true) {
      const chunk = await new Promise((resolve) => { send = resolve; });
      if (chunk === null) return;
      yield { type: "text-delta", text: chunk };
      consumed();
    }
  } });
  const session = makeSession();
  host.add(session);
  apply(host.ctx);
  host.end(session);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const [chunk, prediction] of [
    ["```js", ""],
    ["on\n{\"suggestion\":\"你", "你"],
    ["好\\uD83D", "你好"],
    ["\\uDE00\"}\n```", "你好😀"],
  ]) {
    const done = new Promise((resolve) => { consumed = resolve; });
    send(chunk);
    await done;
    assert.equal((await host.poll()).prediction, prediction);
  }
  send(null);
  assert.equal((await settle(host)).prediction, "你好😀");
});

test("does not expose null or unrelated JSON while pending", async () => {
  for (const text of ['{"suggestion":null', '{"other":"secret', 'not JSON', '```json\n{"other":"secret', 'intro\n```json\n{"suggestion":"secret']) {
    let release;
    let started;
    const received = new Promise((resolve) => { started = resolve; });
    const host = makeHost({ stream: async function* () {
      yield { type: "text-delta", text };
      started();
      await new Promise((resolve) => { release = resolve; });
    } });
    const session = makeSession();
    host.add(session);
    apply(host.ctx);
    host.end(session);
    await received;
    assert.equal((await host.poll()).prediction, "", text);
    release();
    assert.equal((await settle(host)).prediction, "", text);
  }
});

test("clears streamed prefixes on invalid output, failure, timeout and cancellation", async () => {
  for (const outcome of ["invalid", "error", "throw", "timeout", "cancel"]) {
    let proceed;
    let started;
    const received = new Promise((resolve) => { started = resolve; });
    const host = makeHost({ stream: async function* () {
      yield { type: "text-delta", text: '{"suggestion":"草稿' };
      started();
      await new Promise((resolve) => { proceed = resolve; });
      if (outcome === "invalid") yield { type: "text-delta", text: '\\q"}' };
      if (outcome === "error") yield { type: "finish", reason: { kind: "error" } };
      if (outcome === "throw") throw new Error("failed");
    } });
    const session = makeSession();
    host.add(session);
    apply(host.ctx, { timeoutMs: outcome === "timeout" ? 30 : 30000 });
    host.end(session);
    await received;
    assert.equal((await host.poll()).prediction, "草稿");
    if (outcome === "cancel") {
      host.emit("session/disposed", session);
      assert.equal((await host.poll()).status, "none");
      proceed();
    } else {
      if (outcome !== "timeout") proceed();
      const state = await settle(host);
      assert.equal(state.status, "ready", outcome);
      assert.equal(state.prediction, "", outcome);
      if (outcome === "timeout") proceed();
    }
  }
});

test("logs stage and stream timings without model content", async () => {
  const host = makeHost({ stream: async function* () {
    yield { type: "reasoning-delta", text: "private reasoning" };
    yield { type: "text-delta", text: '{"suggestion":"private suggestion"}' };
    yield { type: "finish", reason: { kind: "stop" } };
  } });
  const session = makeSession();
  host.add(session);
  apply(host.ctx);
  const result = await settle(host, session);
  assert.equal(result.prediction, "private suggestion");
  for (const event of ["route_timing", "context_timing", "prepare_timing"]) {
    assert.match(host.infos.find((line) => line.includes(`event=${event} `)) ?? "", /elapsedMs=\d+/);
  }
  const summary = host.infos.find((line) => line.includes("event=stream_summary ")) ?? "";
  assert.match(summary, /firstReasoningMs=\d+ firstTextMs=\d+ finishMs=\d+ streamElapsedMs=\d+/);
  assert.doesNotMatch(host.infos.join("\n"), /private reasoning|private suggestion/);
});

test("another model gets only real user messages, summaries and assistant replies", async () => {
  const host = makeHost({ catalog: { chat: ["big", "small"] } });
  const session = makeSession();
  session.messages.splice(3, 0, userMessage("<compacted-summary>早先要求保留接口兼容</compacted-summary>", "compact-checkpoint"));
  host.add(session);
  apply(host.ctx, { predictionModel: "small" });

  const state = await settle(host, session);
  assert.equal(state.prediction, "继续运行测试");
  const sent = host.calls[0].messages.slice(0, -1);
  assert.deepEqual(sent.map((message) => message.content[0].text), [
    "<compacted-summary>早先要求保留接口兼容</compacted-summary>",
    "帮我把默认错误码改成 10000",
    "已修改，还没有运行测试。",
  ]);
});

test("different model filters messages before applying the count limit", async () => {
  const host = makeHost({ catalog: { chat: ["big", "small"] } });
  const session = makeSession({ messages: [
    ...Array.from({ length: 85 }, (_, i) => userMessage(`message ${i}`)),
    ...Array.from({ length: 90 }, () => userMessage("ignored", "agent-instructions")),
    assistantMessage("latest reply"),
  ] });
  host.add(session);
  apply(host.ctx, { predictionModel: "small" });

  await settle(host, session);
  const sent = host.calls[0].messages.slice(0, -1);
  assert.equal(sent.length, 80);
  assert.equal(sent[0].content[0].text, "message 6");
  assert.equal(sent.at(-1).content[0].text, "latest reply");
});

test("different model bounds an oversized latest message including text block separators", async () => {
  const host = makeHost({ catalog: { chat: ["big", "small"] } });
  const longText = `${"a".repeat(60000)}\n${"b".repeat(60000)}`;
  const session = makeSession({ messages: [
    userMessage("older"),
    { role: "assistant", content: [ ...text("a".repeat(60000)), ...text("b".repeat(60000)) ] },
  ] });
  host.add(session);
  apply(host.ctx, { predictionModel: "small" });

  await settle(host, session);
  const sent = host.calls[0].messages.slice(0, -1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content[0].text.length, 100000);
  assert.equal(sent[0].content[0].text, longText.slice(-100000));
});

test("different model retains recent whole messages within the character limit", async () => {
  const host = makeHost({ catalog: { chat: ["big", "small"] } });
  const session = makeSession({ messages: [userMessage("x".repeat(50001)), assistantMessage("y".repeat(50000))] });
  host.add(session);
  apply(host.ctx, { predictionModel: "small" });

  await settle(host, session);
  const sent = host.calls[0].messages.slice(0, -1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content[0].text.length, 50000);
});

test("uses an explicit provider and model", async () => {
  const host = makeHost({ catalog: { chat: ["big"], responses: ["small"] } });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, { predictionProvider: "responses", predictionModel: "small" });

  await settle(host, session);
  assert.equal(host.calls[0].config.provider, "responses");
  assert.equal(host.calls[0].config.model, "small");
  // A different model does not inherit the session's reasoning effort.
  assert.equal(host.calls[0].config.reasoningEffort, "off");
});

test("routes predictions through explicitly selected OpenAI-compatible providers", async () => {
  for (const provider of ["chat-gateway", "responses-gateway"]) {
    const host = makeHost({
      catalog: { chat: ["big"], [provider]: [] },
      resolveModel: async (id, model) => {
        assert.deepEqual([id, model], [provider, "custom-model"]);
        return { provider: id, id: model };
      },
    });
    const session = makeSession();
    host.add(session);
    apply(host.ctx, { predictionProvider: provider, predictionModel: "custom-model" });

    const state = await settle(host, session);
    assert.equal(state.prediction, "继续运行测试");
    assert.deepEqual([host.calls[0].config.provider, host.calls[0].config.model], [provider, "custom-model"]);
    assert.equal(host.calls[0].options.messages.at(-1).role, "user");
  }
});

test("finds the only provider offering a model configured without provider", async () => {
  const host = makeHost({ catalog: { chat: ["big"], responses: ["small"], other: ["x"] } });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, { predictionModel: "small" });

  await settle(host, session);
  assert.deepEqual([host.calls[0].config.provider, host.calls[0].config.model], ["responses", "small"]);
});

test("prefers the session provider when it offers the configured model", async () => {
  const host = makeHost({ catalog: { chat: ["big", "small"], responses: ["small"] } });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, { predictionModel: "small" });

  await settle(host, session);
  assert.deepEqual([host.calls[0].config.provider, host.calls[0].config.model], ["chat", "small"]);
});

test("falls back to the session route when the configured model is unavailable or ambiguous", async () => {
  for (const config of [
    { predictionProvider: "responses", predictionModel: "missing" },
    { predictionModel: "shared" },
  ]) {
    const host = makeHost({ catalog: { chat: ["big"], a: ["shared"], b: ["shared"], responses: ["small"] } });
    const session = makeSession();
    host.add(session);
    apply(host.ctx, config);

    await settle(host, session);
    assert.deepEqual([host.calls[0].config.provider, host.calls[0].config.model], ["chat", "big"]);
    // No configured effort: the model's lowest, not the session's "high".
    assert.equal(host.calls[0].config.reasoningEffort, "off");
  }
});

test("does not predict after interrupted or failed turns", async () => {
  for (const reason of ["aborted", "error", "user"]) {
    const host = makeHost();
    const session = makeSession({ events: completedEvents(reason) });
    host.add(session);
    apply(host.ctx, {});

    host.emit("session/event", session, session.events.at(-1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await host.poll(), { status: "none" });
    assert.equal(host.calls.length, 0);
  }
});

test("predicts as soon as a completed turn ends", async () => {
  const host = makeHost();
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  host.emit("session/event", session, session.events.at(-1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.calls.length, 1);
  assert.match(host.infos.join("\n"), /event=loaded enabled=true/);
  assert.match(host.infos.join("\n"), /event=turn_end hasSession=true reason=completed/);
  assert.match(host.infos.join("\n"), /event=request_prepare request=\d+ provider=chat model=big/);
  assert.match(host.infos.join("\n"), /event=request_stream request=\d+/);
  assert.match(host.infos.join("\n"), /event=response_parsed request=\d+ .*reason=ok/);
});

test("logs why a completed turn is skipped", async () => {
  for (const [overrides, config, reason] of [
    [{}, { enabled: false }, "disabled"],
    [{ header: { parentSession: "parent" } }, {}, "subsession"],
    [{ route: {} }, {}, "missing_route"],
    [{ events: [{ type: "turn/start", seq: 1 }, { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } }] }, {}, "assistant_message_missing"],
  ]) {
    const host = makeHost();
    const session = makeSession(overrides);
    host.add(session);
    apply(host.ctx, config);
    host.end(session);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(host.calls.length, 0);
    assert.match(host.infos.join("\n"), new RegExp(`event=skip trigger=turn-end .*reason=${reason}|event=skip trigger=turn-end reason=${reason}`));
  }
});

test("unloading the plugin cancels scheduled and in-flight predictions without affecting another instance", async () => {
  let started;
  const streamStarted = new Promise((resolve) => { started = resolve; });
  const first = makeHost({ stream: ({ signal }) => (async function* () {
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })() });
  const active = makeSession();
  const scheduled = makeSession();
  first.add(active);
  first.add(scheduled);
  apply(first.ctx);
  first.end(active);
  await streamStarted;

  const second = makeHost();
  second.add(active);
  apply(second.ctx);
  assert.equal((await settle(second, active)).prediction, "继续运行测试");
  first.end(scheduled);
  first.dispose();
  assert.equal(first.calls[0].signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.calls.length, 1);
  assert.equal((await second.poll(active.id)).prediction, "继续运行测试");
});

test("disposing a session cancels scheduled turn-end predictions", async () => {
  const host = makeHost();
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  host.end(session);
  host.end(session);
  host.emit("session/disposed", session);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.calls.length, 0);
  assert.deepEqual(await host.poll(), { status: "none" });
  assert.match(host.infos.join("\n"), /event=disposed scheduled=true state=none/);
});

test("disposing a session aborts its in-flight prediction", async () => {
  let started;
  const streamStarted = new Promise((resolve) => { started = resolve; });
  const host = makeHost({ stream: ({ signal }) => (async function* () {
    started();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })() });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  host.end(session);
  await streamStarted;
  assert.equal((await host.poll()).status, "pending");
  host.emit("session/disposed", session);
  assert.equal(host.calls[0].signal.aborted, true);
  assert.deepEqual(await host.poll(), { status: "none" });
  assert.match(host.infos.join("\n"), /event=disposed scheduled=false state=pending request=\d+ flow=\d+/);
  assert.match(host.infos.join("\n"), /event=cancel request=\d+ flow=\d+ reason=disposed elapsedMs=\d+/);
});

test("starting another turn cancels a scheduled prediction", async () => {
  const host = makeHost();
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  host.end(session);
  host.emit("session/event", session, { type: "turn/start" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.calls.length, 0);
});

test("starts a focus-idle fallback once and reuses the existing prediction", async () => {
  const host = makeHost();
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  await host.triggerFocusIdle();
  const state = await settle(host, session);
  assert.equal(state.prediction, "继续运行测试");
  await host.triggerFocusIdle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.calls.length, 1);
});

test("retries an empty prediction on focus-idle", async () => {
  let attempts = 0;
  const host = makeHost({
    stream: () => (async function* () {
      attempts += 1;
      yield { type: "text-delta", text: attempts === 1 ? '{"suggestion":null}' : '{"suggestion":"继续运行测试"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    })(),
  });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  const first = await settle(host, session);
  assert.equal(first.prediction, "");
  assert.equal(first.reason, "model_declined");
  assert.match(host.warnings.join("\n"), /result=model_declined trigger=turn-end completionSeq=/);
  await host.triggerFocusIdle();
  const second = await settle(host, session);
  assert.equal(second.prediction, "继续运行测试");
  assert.equal(second.reason, "ok");
  assert.equal(host.calls.length, 2);
});

test("limits empty focus-idle predictions to one per completed turn", async () => {
  const host = makeHost({ reply: '{"suggestion":null}' });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  await settle(host, session);
  await host.triggerFocusIdle();
  await settle(host);
  assert.equal(host.calls.length, 2);
  await host.triggerFocusIdle();
  await settle(host);
  assert.equal(host.calls.length, 2);
  const starts = host.infos.filter((line) => line.includes("event=start"));
  assert.equal(starts.length, 2);
  const firstFlow = starts[0].match(/flow=(\d+)/)?.[1];
  assert.ok(firstFlow);
  assert.match(starts[0], new RegExp(`flow=${firstFlow} attempt=1 trigger=turn-end`));
  assert.match(starts[1], new RegExp(`flow=${firstFlow} attempt=2 trigger=focus-idle`));
  assert.equal(host.infos.filter((line) => line.includes("event=retry_suppressed")).length, 1);
  assert.match(host.warnings.join("\n"), /result=model_declined.*elapsedMs=\d+/);
  const logs = [...host.infos, ...host.warnings].join("\n");
  assert.doesNotMatch(logs, /帮我把默认错误码改成|已修改，还没有运行测试|suggestion|s\d+\b/);

  session.events = [
    ...session.events,
    { type: "turn/start", seq: 4, data: { turn: 2 } },
    { type: "assistant/message", seq: 5, data: {} },
    { type: "turn/end", seq: 6, data: { turn: 2, reason: { kind: "completed" } } },
  ];
  host.emit("session/event", session, session.events.at(-3));
  await settle(host, session);
  await host.triggerFocusIdle();
  await settle(host);
  assert.equal(host.calls.length, 4);
});

test("does not retry an empty focus-idle prediction when there was no initial prediction", async () => {
  const host = makeHost({ reply: '{"suggestion":null}' });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});

  await host.triggerFocusIdle();
  await settle(host);
  await host.triggerFocusIdle();
  await settle(host);
  assert.equal(host.calls.length, 1);
});

test("times out a provider that never answers", async () => {
  const host = makeHost({
    // Ignores the abort signal on purpose.
    stream: () => (async function* () { await new Promise(() => {}); })(),
  });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, { timeoutMs: 20 });

  const state = await settle(host, session);
  assert.deepEqual([state.status, state.prediction, state.reason], ["ready", "", "timeout"]);
  assert.equal(host.calls[0].signal.aborted, true);
  assert.match(host.warnings.join("\n"), /timed out after 20ms/);
});

test("the session model replays the session's own request prefix for cache hits", async () => {
  const host = makeHost();
  const tools = [{ name: "bash", description: "run", parameters: {} }];
  const session = makeSession({ tools });
  host.add(session);
  apply(host.ctx, {});

  await settle(host, session);
  const { options } = host.calls[0];
  assert.deepEqual(options.messages.slice(0, -1), session.messages);
  assert.deepEqual(options.tools, tools);
  assert.deepEqual(options.toolHistory, { tools, updates: [] });
  assert.match(options.messages.at(-1).content[0].text, /Predict the next message/);
  assert.match(options.messages.at(-1).content[0].text, /\{"suggestion":null\}/);
  assert.match(options.messages.at(-1).content[0].text, /"additionalProperties":false/);
});

test("uses a configured effort the model supports", async () => {
  const host = makeHost();
  const session = makeSession();
  host.add(session);
  apply(host.ctx, { reasoningEffort: "low" });

  await settle(host, session);
  assert.equal(host.calls[0].config.reasoningEffort, "low");
});

test("opening an old session never calls the model", async () => {
  const host = makeHost();
  host.add(makeSession());
  apply(host.ctx, {});

  for (let i = 0; i < 3; i += 1) assert.deepEqual(await host.poll(), { status: "none" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.calls.length, 0);
});

test("warns when the reply runs out of tokens", async () => {
  const host = makeHost({
    stream: () => (async function* () {
      yield { type: "text-delta", text: '{"suggestion":"继' };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    })(),
  });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, { maxTokens: 8 });

  const state = await settle(host, session);
  assert.equal(state.prediction, "");
  assert.equal(state.reason, "max_tokens");
  assert.match(host.warnings.join("\n"), /hit maxTokens \(8\)/);
});

test("classifies model output through the registered endpoint", async () => {
  const cases = [
    ["", "empty_output", ""],
    ["  \n", "empty_output", ""],
    ["plain text", "invalid_json", ""],
    ['{"suggestion":', "invalid_json", ""],
    ['{"suggestion":"first"}{"suggestion":"second"}', "invalid_json", ""],
    ['{"other":"value"}', "invalid_suggestion", ""],
    ['{"suggestion":42}', "invalid_suggestion", ""],
    ['{"suggestion":"  "}', "invalid_suggestion", ""],
    ['{"suggestion":null}', "model_declined", ""],
    ['```json\n{"suggestion":"继续"}\n```', "ok", "继续"],
    ['{"suggestion":" first\\r\\nsecond "}', "ok", "first\nsecond"],
  ];
  for (const [reply, reason, prediction] of cases) {
    const host = makeHost({ reply });
    const session = makeSession();
    host.add(session);
    apply(host.ctx, {});
    const state = await settle(host, session);
    assert.equal(state.status, "ready", reply);
    assert.equal(state.reason, reason, reply);
    assert.equal(state.prediction, prediction, reply);
  }
});

test("logs invalid JSON structure without exposing model output", async () => {
  const cases = [
    ["secretprefix and secretsuffix", "missing_left_brace", null, null, false, false],
    ['secretprefix {"suggestion":"secretsuffix', "missing_right_brace", 13, null, false, false],
    ["  ```json\n{a}\n```  ", "parse_error", 10, 1, true, true],
    ['{"suggestion":}', "parse_error", 0, null, false, false],
  ];
  for (const [reply, stage, candidateStart, errorPosition, startsWithFence, endsWithFence] of cases) {
    const host = makeHost({ stream: () => (async function* () {
      yield { type: "text-delta", text: reply };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    })() });
    const session = makeSession();
    host.add(session);
    apply(host.ctx);
    const state = await settle(host, session);
    assert.equal(state.reason, "max_tokens");
    assert.equal(state.prediction, "");
    const line = host.infos.find((item) => item.includes("event=invalid_json "));
    assert.ok(line);
    const detail = JSON.parse(line.slice(line.indexOf("detail=") + 7));
    assert.deepEqual(detail, {
      outputChars: reply.length,
      first: reply.trim().startsWith("```") ? "backtick" : reply.startsWith("secret") ? "letter" : "left_brace",
      last: reply.trim().endsWith("```") ? "backtick" : reply.endsWith("}") ? "right_brace" : "letter",
      startsWithFence, endsWithFence, stage, candidateStart, errorPosition,
    });
    assert.doesNotMatch([...host.infos, ...host.warnings].join("\n"), /secretprefix|secretsuffix|suggestion|```json/);
  }
});

test("reports missing conversation context without calling the provider", async () => {
  const host = makeHost();
  const session = makeSession({ messages: [] });
  host.add(session);
  apply(host.ctx, {});
  const state = await settle(host, session);
  assert.deepEqual([state.status, state.prediction, state.reason], ["ready", "", "no_context"]);
  assert.equal(host.calls.length, 0);
});

test("classifies provider failures without exposing their contents", async () => {
  const secret = "sensitive provider error and user content";
  for (const stream of [
    () => (async function* () { yield { type: "finish", reason: { kind: "error", failure: { message: secret } } }; })(),
    () => (async function* () { throw new Error(secret); })(),
    () => (async function* () { yield { type: "finish", reason: { kind: "aborted", failure: { message: secret } } }; })(),
  ]) {
    const host = makeHost({ stream });
    const session = makeSession();
    host.add(session);
    apply(host.ctx, {});
    const state = await settle(host, session);
    assert.equal(state.reason, "provider_error");
    assert.equal(state.prediction, "");
    assert.doesNotMatch(JSON.stringify(state) + host.warnings.join(" "), /sensitive provider error/);
  }
});

test("counts reasoning and text deltas without logging their contents", async () => {
  const host = makeHost({ stream: () => (async function* () {
    yield { type: "reasoning-delta", index: 0, text: "秘密" };
    yield { type: "reasoning-delta", index: 0, text: "思考" };
    yield { type: "text-delta", index: 1, text: '{"suggestion":"继续"}' };
    yield { type: "finish", reason: { kind: "stop" } };
  })() });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});
  assert.equal((await settle(host, session)).prediction, "继续");
  const logs = [...host.infos, ...host.warnings].join("\n");
  assert.match(logs, /reasoningDeltas=2 reasoningChars=4 textDeltas=1 textChars=19 finishReason=stop/);
  assert.doesNotMatch(logs, /秘密|思考|继续/);
});

test("diagnostics validates and logs only allowlisted client state", async () => {
  const host = makeHost();
  apply(host.ctx, {});
  const route = host.routes.get("/api/dsh-input-prediction/diagnostics");
  assert.deepEqual(route.methods, ["POST"]);
  assert.equal(route.requestBody, "buffered");
  const send = (body) => route.fetch(new Request("http://local/api/dsh-input-prediction/diagnostics", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  for (const body of [
    { event: "loaded", detail: {} },
    { event: "poll", detail: { state: "http-error", status: 503 } },
    { event: "backend", detail: { status: "ready", reason: "ok", hasPrediction: true } },
    { event: "display", detail: Object.fromEntries(["visible", "hasCurrent", "currentSession", "dismissed", "locked", "busy", "empty", "composing", "focused"].map((key) => [key, false])) },
    { event: "idle", detail: { state: "requested" } },
  ]) assert.equal((await send(body)).status, 200);
  for (const body of [
    { event: "loaded", detail: { sessionId: "secret" } },
    { event: "poll", detail: { state: "secret" } },
    { event: "poll", detail: { state: "ok", status: "200" } },
    { event: "backend", detail: { status: "ready", reason: "secret", hasPrediction: true } },
    { event: "display", detail: { visible: true, text: "secret" } },
    { event: "idle", detail: { state: "requested" }, error: "secret" },
  ]) assert.equal((await send(body)).status, 400);
  assert.doesNotMatch(host.infos.join("\n"), /secret/);
});

test("reports max tokens while preserving a complete parsed suggestion", async () => {
  const host = makeHost({ stream: () => (async function* () {
    yield { type: "text-delta", text: '{"suggestion":"继续"}' };
    yield { type: "finish", reason: { kind: "max-tokens" } };
  })() });
  const session = makeSession();
  host.add(session);
  apply(host.ctx, {});
  const state = await settle(host, session);
  assert.equal(state.reason, "max_tokens");
  assert.equal(state.prediction, "继续");
});

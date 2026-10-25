import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../index.js";

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

function makeHost({ catalog = {}, reply = '{"suggestion":"继续运行测试"}', stream } = {}) {
  const calls = [];
  const warnings = [];
  const listeners = {};
  let route;
  let lastSession;
  const sessions = new Map();
  const ctx = {
    on(name, listener) { listeners[name] = listener; },
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
    connection: { fetch: { register(definition) { route = definition; } } },
    sessions: { get: (id) => sessions.get(id) },
    sessionProjections: { stateOf: () => undefined },
    llm: {
      listProviders: () => Object.keys(catalog).map((id) => ({ id })),
      listModels: async (provider) => (catalog[provider] || []).map((id) => ({ id })),
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
    add(session) { lastSession = session.id; sessions.set(session.id, session); },
    // A live turn/end is the only thing that starts a prediction.
    end(session) { listeners["session/event"]?.(session, session.events.at(-1)); },
    emit: (name, ...args) => listeners[name]?.(...args),
    async poll(sessionId = lastSession) {
      const response = await route.fetch(new Request(`http://local/api/dsh-input-prediction?sessionId=${sessionId}`));
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
  assert.deepEqual([state.status, state.prediction], ["ready", ""]);
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
  assert.match(host.warnings.join("\n"), /hit maxTokens \(8\)/);
});

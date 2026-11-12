import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { apply } from "../lib/index.js";

// Use the adapter shipped by DSH; DSH_ROOT can point to a different installation.
const dshRoot = process.env.DSH_ROOT || "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const adapterPath = `${dshRoot}/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`;
if (process.env.DSH_ROOT && !existsSync(adapterPath)) throw new Error(`DSH adapter not found: ${adapterPath}`);
const applyPiAi = existsSync(adapterPath) ? (await import(adapterPath)).apply : null;

for (const api of ["openai-completions", "openai-responses"]) {
  test(`prediction uses the real pi-ai ${api} adapter against local HTTP`, { skip: !applyPiAi && "DSH adapter not installed; set DSH_ROOT" }, async (t) => {
    const requests = [];
    const suggestion = '{"suggestion":"继续运行测试"}';
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url, method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (api === "openai-completions") {
        send({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: suggestion }, finish_reason: null }] });
        send({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        send({ type: "response.created", response: { id: "fixture" } });
        send({ type: "response.output_item.added", output_index: 0, item: { id: "msg_fixture", type: "message", role: "assistant", content: [] } });
        send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: suggestion });
        send({ type: "response.output_item.done", output_index: 0, item: { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: suggestion }] } });
        send({ type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
      }
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, new URL(baseURL).origin, `unexpected network destination: ${url.origin}`);
      return originalFetch(input, init);
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    let adapter;
    const credentials = { resolve: async () => ({ value: "fixture-key" }), readRecord: async () => undefined };
    const adapterCtx = {
      fiber: {}, logger: { warn() {}, error() {} },
      inject() {}, on() {}, get: (name) => name === "credentials" ? credentials : undefined,
      waterfall: (_name, _request, _headers, next) => next(),
      llm: {
        registerConfigurableProviders() {}, registerModelDiscovery() {},
        registerAdapter(_routes, value) { adapter = value; },
      },
    };
    applyPiAi(adapterCtx, { providers: { get: () => ({ fixture: { api, baseURL, apiKeyEnv: "FIXTURE_KEY", models: [{ id: "fixture-model" }] } }) } });
    assert.ok(adapter, "real pi-ai adapter registered");
    const events = [
      { type: "turn/start", seq: 1 },
      { type: "assistant/message", seq: 2 },
      { type: "turn/end", seq: 3, data: { reason: { kind: "completed" } } },
    ];
    const session = {
      id: `integration-${api}`, header: {}, snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: "fixture", model: "fixture-model" } }),
      deriveMessages: () => [
        { role: "user", content: [{ type: "text", text: "帮我修改代码" }] },
        { role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture-model" }, content: [{ type: "text", text: "已修改" }] },
      ],
    };
    let route;
    const warnings = [];
    const ctx = {
      effect(callback) { t.after(callback()); },
      on() {}, logger: { warn: (...args) => warnings.push(args.map((arg) => arg instanceof Error ? arg.stack : arg)) },
      connection: { fetch: { register(definition) { route = definition; } } },
      sessions: { get: () => session }, sessionProjections: { stateOf: () => undefined },
      llm: {
        resolveModelInfo: (provider, model) => adapter.resolveModel(provider, model),
        async prepareCall(config, signal, configure) {
          const prepared = await adapter.prepareCall(config.provider, config.model, signal);
          return { config: { ...config, ...configure({}, prepared.model) }, stream: prepared.stream };
        },
      },
    };
    apply(ctx, { timeoutMs: 3000, maxTokens: 160, predictionProvider: "fixture", predictionModel: "fixture-model" });
    const url = `http://local/api/dsh-input-prediction?sessionId=${session.id}`;
    await route.fetch(new Request(`${url}&trigger=focus-idle`));
    let state;
    for (let i = 0; i < 200; i++) {
      state = await (await route.fetch(new Request(url))).json();
      if (state.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(state, { status: "ready", completionSeq: 3, prediction: "继续运行测试", reason: "ok" }, JSON.stringify(warnings));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].path, api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses");
    assert.equal(requests[0].body.model, "fixture-model");
    assert.equal(requests[0].body.stream, true);
    const serialized = JSON.stringify(requests[0].body);
    assert.match(serialized, /帮我修改代码/);
    assert.match(serialized, /已修改/);
    assert.match(serialized, /Predict the next message/);
  });
}

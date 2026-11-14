import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { apply } from '../../lib/index.js';

// The host module supplies an actual DSH-compatible llm service; it must not
// read the scoring rubric or include credentials in the returned metadata.
const [inputPath, outputPath, hostPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !hostPath) {
  console.error('Usage: node research/production-hardcases/run.mjs INPUT.json OUTPUT.json HOST_MODULE.mjs');
  process.exit(2);
}
const inputsBytes = await readFile(inputPath);
const inputs = JSON.parse(inputsBytes);
if (!Array.isArray(inputs) || inputs.some((item) => typeof item?.id !== 'string' || !Array.isArray(item.messages)
  || item.messages.some((message) => !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'))) {
  throw new Error('Input must be an array of {id, messages: [{role: user|assistant, content: string}]}');
}
const host = await import(pathToFileURL(resolve(hostPath)).href);
if (typeof host.createLlm !== 'function' || !host.provider || !host.model) {
  throw new Error('HOST_MODULE must export createLlm(), provider, and model');
}
const llm = await host.createLlm();
// Reserve a fresh result file before any calls, protecting inputs and prior runs.
await writeFile(outputPath, '', { flag: 'wx' });
const results = [];
for (const item of inputs) {
  const record = { id: item.id, startedAt: new Date().toISOString(), attempts: [], status: null, error: null };
  results.push(record);
  let route;
  const cleanups = [];
  const session = {
    id: `eval-${item.id}`,
    header: {},
    snapshotEvents: () => [
      { type: 'turn/start', seq: 1 },
      { type: 'assistant/message', seq: 2 },
      { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
    ],
    requestHeader: () => ({ config: { provider: host.provider, model: host.model } }),
    deriveMessages: () => item.messages.map(({ role, content }) => ({
      role,
      content: [{ type: 'text', text: content }],
      ...(role === 'assistant' ? { source: { kind: 'model', provider: 'synthetic', model: 'synthetic' } } : {}),
    })),
  };
  const ctx = {
    on() {},
    effect(setup) { cleanups.push(setup()); },
    logger: { info() {}, warn() {} },
    connection: { fetch: { register(definition) { if (definition.path === '/api/dsh-input-prediction') route = definition; } } },
    sessions: { get: (id) => id === session.id ? session : undefined },
    sessionProjections: { snapshot: () => ({ values: { plan: { active: false } } }) },
    llm: {
      resolveModelInfo: (...args) => llm.resolveModelInfo(...args),
      listProviders: (...args) => llm.listProviders(...args),
      listModels: (...args) => llm.listModels(...args),
      async prepareCall(config, signal, configure) {
        const attempt = { requested: { provider: config.provider, model: config.model, maxTokens: config.maxTokens }, effective: null, messages: null, rawOutput: '', finish: null, error: null };
        record.attempts.push(attempt);
        try {
          const call = await llm.prepareCall(config, signal, configure);
          const c = call.config || {};
          attempt.effective = { provider: c.provider ?? null, model: c.model ?? null, maxTokens: c.maxTokens ?? null, reasoningEffort: c.reasoningEffort ?? null, temperature: c.temperature ?? null, seed: c.seed ?? null };
          return {
            config: call.config,
            async *stream(request) {
              attempt.messages = request.messages;
              try {
                for await (const chunk of call.stream(request)) {
                  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') attempt.rawOutput += chunk.text;
                  if (chunk?.type === 'finish') attempt.finish = {
                    kind: chunk.reason?.kind ?? null,
                    code: chunk.reason?.failure?.code ?? null,
                    message: chunk.reason?.failure?.message ?? null,
                  };
                  yield chunk;
                }
              } catch (error) {
                attempt.error = { name: error?.name ?? null, code: error?.code ?? null, message: error?.message ?? String(error) };
                throw error;
              }
            },
          };
        } catch (error) {
          attempt.error = { name: error?.name ?? null, code: error?.code ?? null, message: error?.message ?? String(error) };
          throw error;
        }
      },
    },
  };
  try {
    apply(ctx, { timeoutMs: 30000, ...(host.config || {}), fallbackToSession: false });
    const url = `http://local/api/dsh-input-prediction?sessionId=${encodeURIComponent(session.id)}`;
    await route.fetch(new Request(`${url}&trigger=focus-idle`));
    const timeout = Number.isSafeInteger(host.config?.timeoutMs) && host.config.timeoutMs > 0 ? host.config.timeoutMs : 30000;
    const deadline = Date.now() + timeout + 5000;
    do {
      record.status = await (await route.fetch(new Request(url))).json();
      if (record.status.status !== 'pending') break;
      await new Promise((done) => setTimeout(done, 20));
    } while (Date.now() < deadline);
    if (record.status.status !== 'ready') {
      record.error = { reason: 'not_ready', message: 'prediction did not reach ready' };
    } else if (['provider_error', 'timeout', 'missing_route', 'no_context', 'other'].includes(record.status.reason)) {
      const attempt = record.attempts.at(-1);
      record.error = { reason: record.status.reason, code: attempt?.error?.code ?? attempt?.finish?.code ?? null, message: attempt?.error?.message ?? attempt?.finish?.message ?? null };
    }
  } catch (error) {
    record.error = { name: error?.name ?? null, code: error?.code ?? null, message: error?.message ?? String(error) };
  } finally {
    for (const cleanup of cleanups) cleanup?.();
    record.finishedAt = new Date().toISOString();
    await writeFile(outputPath, JSON.stringify({ inputSha256: createHash('sha256').update(inputsBytes).digest('hex'), host: { provider: host.provider, model: host.model, description: host.description ?? null }, results }, null, 2) + '\n', { flag: 'w' });
  }
}

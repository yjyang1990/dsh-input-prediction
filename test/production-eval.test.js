import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

test('evaluation runner passes separate cases through production generation and captures raw output', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prediction-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  const host = join(dir, 'host.mjs');
  await writeFile(input, JSON.stringify([
    { id: 'one', messages: [{ role: 'user', content: 'task one' }, { role: 'assistant', content: 'done one' }], criteria: 'must remain hidden' },
    { id: 'two', messages: [{ role: 'user', content: 'task two' }, { role: 'assistant', content: 'done two' }] },
  ]));
  await writeFile(host, `export const provider = 'fixture'; export const model = 'fixture-model';
export async function createLlm() { return {
  async resolveModelInfo(provider, model) { return { provider, id: model }; },
  async prepareCall(config, signal, configure) { return { config: { ...config, ...configure({}, { reasoning: { efforts: [{ id: 'none' }] } }) },
    async *stream() { yield { type: 'text-delta', text: '{"suggestion":null}' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }; }
}; }`);
  await exec(process.execPath, ['research/production-hardcases/run.mjs', input, output, host]);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.results.length, 2);
  for (const [index, result] of report.results.entries()) {
    assert.equal(result.status.reason, 'model_declined');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].rawOutput, '{"suggestion":null}');
    const messages = result.attempts[0].messages;
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.equal(messages[0].content[0].text, `task ${index ? 'two' : 'one'}`);
    assert.deepEqual(messages[1].source, { kind: 'model', provider: 'synthetic', model: 'synthetic' });
    assert.match(messages[2].content[0].text, /Recommend the next concrete request/);
    assert.doesNotMatch(JSON.stringify(messages), /must remain hidden/);
  }
});

test('evaluation runner classifies provider finish errors and preserves details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prediction-eval-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  const host = join(dir, 'host.mjs');
  await writeFile(input, JSON.stringify([{ id: 'failure', messages: [{ role: 'user', content: 'task' }] }]));
  await writeFile(host, `export const provider = 'fixture'; export const model = 'fixture-model';
export async function createLlm() { return {
  async resolveModelInfo(provider, model) { return { provider, id: model }; },
  async prepareCall(config, signal, configure) { return { config: { ...config, ...configure({}, { reasoning: { efforts: [{ id: 'none' }] } }) },
    async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_FAILURE', message: 'upstream failure' } } }; }
  }; }
}; }`);
  await exec(process.execPath, ['research/production-hardcases/run.mjs', input, output, host]);
  const { results: [result] } = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.status.reason, 'provider_error');
  assert.deepEqual(result.attempts[0].finish, { kind: 'error', code: 'PROVIDER_FAILURE', message: 'upstream failure' });
  assert.deepEqual(result.error, { reason: 'provider_error', code: 'PROVIDER_FAILURE', message: 'upstream failure' });
});

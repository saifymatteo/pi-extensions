import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

const schema = new Proxy({}, { get: () => (..._args) => ({}) });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tts-test-'));
  mkdirSync(join(dir, 'extensions'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  });
  const save = (name, data) => writeFileSync(join(dir, 'extensions', name), JSON.stringify(data));
  save('service-models.json', { providers: { local: { baseUrl: 'http://localhost:8000/v1', apiKey: '', models: [
    { id: 'voice', type: 'tts', api: 'openai-audio-speech' },
  ] } } });
  return { dir, save };
}

const registry = (model = {}) => ({ providers: { local: { baseUrl: 'http://localhost:8000/v1', apiKey: '', models: [
  { id: 'voice', type: 'tts', api: 'openai-audio-speech', ...model },
] } } });

test('TTS registry model carries voice/language defaults; empty values are rejected', t => {
  const { dir, save } = setup(t);
  const { loadServiceConfig } = loadExtension(fileURLToPath(new URL('../src/lib/service-models.ts', import.meta.url)));
  save('service-models.json', registry({ voice: 'example', language: 'en' }));
  const model = loadServiceConfig(dir, 'tts').providers.local.models[0];
  assert.equal(model.voice, 'example');
  assert.equal(model.language, 'en');
  save('service-models.json', registry({ voice: '' }));
  assert.throws(() => loadServiceConfig(dir, 'tts'), /Invalid or duplicate model/);
});

test('TTS tool stays absent without a tts registry model; validation rejects invalid and existing outputs before request', async t => {
  const { dir, save } = setup(t);
  const tools = [];
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type: schema } });
  save('service-models.json', { providers: {} });
  extension({ registerTool: tool => tools.push(tool) });
  assert.equal(tools.length, 0);
  save('service-models.json', registry());
  extension({ registerTool: tool => tools.push(tool) });
  assert.equal(tools[0].name, 'text_to_speech');
  const run = params => tools[0].execute('test', params, undefined, undefined, { cwd: dir });
  await assert.rejects(run({ text: '', output_file: 'out.wav' }), /Narration/);
  await assert.rejects(run({ text: 'hello', output_file: 'out.mp3' }), /new .wav/);
  await assert.rejects(run({ text: 'hello', output_file: 'out.wav', model: 'other/voice' }), /Specify a model/);
  writeFileSync(join(dir, 'exists.wav'), 'unchanged');
  await assert.rejects(run({ text: 'hello', output_file: 'exists.wav' }), /already exists/);
});

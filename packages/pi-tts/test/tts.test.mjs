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

test('TTS selector validates defaults and passes them to selected model', t => {
  const { dir, save } = setup(t);
  const { loadServiceConfig } = loadExtension(fileURLToPath(new URL('../src/lib/service-models.ts', import.meta.url)));
  assert.equal(loadServiceConfig(dir, 'tts.json', 'tts'), undefined);
  save('tts.json', { models: ['local/voice'], voice: 'example', language: 'en' });
  const model = loadServiceConfig(dir, 'tts.json', 'tts').providers.local.models[0];
  assert.equal(model.voice, 'example');
  assert.equal(model.language, 'en');
  save('tts.json', { models: ['local/voice'], voice: '' });
  assert.throws(() => loadServiceConfig(dir, 'tts.json', 'tts'), /allowlist/);
});

test('TTS tool stays absent without selector; validation rejects invalid and existing outputs before request', async t => {
  const { dir, save } = setup(t);
  const tools = [];
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type: schema } });
  extension({ registerTool: tool => tools.push(tool) });
  assert.equal(tools.length, 0);
  save('tts.json', { models: ['local/voice'] });
  extension({ registerTool: tool => tools.push(tool) });
  assert.equal(tools[0].name, 'text_to_speech');
  const run = params => tools[0].execute('test', params, undefined, undefined, { cwd: dir });
  await assert.rejects(run({ text: '', output_file: 'out.wav' }), /Narration/);
  await assert.rejects(run({ text: 'hello', output_file: 'out.mp3' }), /new .wav/);
  await assert.rejects(run({ text: 'hello', output_file: 'out.wav', model: 'other/voice' }), /Specify a model/);
  writeFileSync(join(dir, 'exists.wav'), 'unchanged');
  await assert.rejects(run({ text: 'hello', output_file: 'exists.wav' }), /already exists/);
});

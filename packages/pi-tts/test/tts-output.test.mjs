import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

test('TTS saves mock WAV atomically and does not replace existing output', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tts-output-test-'));
  mkdirSync(join(dir, 'extensions'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'extensions', 'service-models.json'), JSON.stringify({ providers: { local: {
    baseUrl: 'http://localhost:8000/v1', apiKey: '', models: [{ id: 'voice', type: 'tts', api: 'openai-audio-speech' }],
  } } }));
  const wav = Buffer.alloc(44);
  wav.write('RIFF'); wav.writeUInt32LE(36, 4); wav.write('WAVE', 8);
  let requests = 0;
  const fetchStub = async (url, options) => {
    requests++;
    assert.equal(String(url), 'http://localhost:8000/v1/audio/speech');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).input, 'fixture narration');
    let sent = false;
    return { ok: true, headers: { get: () => '44' }, body: { getReader: () => ({
      read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: wav }; },
      cancel: async () => {}, releaseLock() {},
    }) } };
  };
  const Type = new Proxy({}, { get: () => () => ({}) });
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type } }, { fetch: fetchStub });
  let tool;
  extension({ registerTool: value => { tool = value; } });
  const params = { text: 'fixture narration', output_file: 'result.wav' };
  const run = () => tool.execute('fixture', params, undefined, undefined, { cwd: dir });
  const result = await run();
  assert.equal(result.structuredContent.bytes, 44);
  assert.equal(readFileSync(join(dir, 'result.wav')).equals(wav), true);
  await assert.rejects(run(), /already exists/);
  assert.equal(requests, 1);
});

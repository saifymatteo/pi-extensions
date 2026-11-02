import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

const helper = () => loadExtension(fileURLToPath(new URL('../src/lib/service-models.ts', import.meta.url)));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-service-test-'));
  mkdirSync(join(dir, 'extensions'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = (file, value) => writeFileSync(join(dir, 'extensions', file), JSON.stringify(value));
  const registry = { providers: { local: { baseUrl: 'http://localhost:8000/v1', apiKey: '$PI_TEST_KEY', models: [
    { id: 'judge', type: 'classifier', api: 'openai-decisions', input: ['text', 'image'], contextWindow: 8192 },
    { id: 'voice', type: 'tts', api: 'openai-audio-speech' },
  ] } } };
  save('service-models.json', registry);
  return { dir, save, registry };
}

test('missing selector disables; allowlists select only matching service type', t => {
  const { dir, save } = fixture(t);
  const { loadServiceConfig } = helper();
  assert.equal(loadServiceConfig(dir, 'decisions.json', 'classifier'), undefined);
  save('decisions.json', { models: ['local/judge'] });
  const cfg = loadServiceConfig(dir, 'decisions.json', 'classifier');
  assert.equal(cfg.providers.local.models.length, 1);
  assert.equal(cfg.providers.local.models[0].id, 'judge');
  save('decisions.json', { models: [] });
  assert.equal(Object.keys(loadServiceConfig(dir, 'decisions.json', 'classifier').providers).length, 0);
  save('decisions.json', { models: ['local/voice'] });
  assert.throws(() => loadServiceConfig(dir, 'decisions.json', 'classifier'), /must have type classifier/);
});

test('invalid allowlists, URLs and model schemas fail without leaking values', t => {
  const { dir, save, registry } = fixture(t);
  const { loadServiceConfig } = helper();
  for (const models of [['local/judge', 'local/judge'], ['local/missing'], [1]]) {
    save('decisions.json', { models });
    assert.throws(() => loadServiceConfig(dir, 'decisions.json', 'classifier'));
  }
  save('decisions.json', { models: ['local/judge'] });
  registry.providers.local.baseUrl = 'https://user:secret@example.invalid/v1';
  save('service-models.json', registry);
  assert.throws(() => loadServiceConfig(dir, 'decisions.json', 'classifier'), error => /Invalid baseUrl/.test(error.message) && !error.message.includes('secret'));
  registry.providers.local.baseUrl = 'http://localhost:8000/v1';
  registry.providers.local.models[0].contextWindow = 0;
  save('service-models.json', registry);
  assert.throws(() => loadServiceConfig(dir, 'decisions.json', 'classifier'), /Invalid or duplicate model/);
  writeFileSync(join(dir, 'extensions', 'decisions.json'), '{"secret": invalid');
  assert.throws(() => loadServiceConfig(dir, 'decisions.json', 'classifier'), error => /Malformed JSON/.test(error.message) && !error.message.includes('secret'));
});

test('environment resolution, missing environment, explicit keyless and auth fallback', t => {
  const { dir } = fixture(t);
  const { configuredApiKey, serviceApiKey } = helper();
  const old = process.env.PI_TEST_KEY;
  t.after(() => { if (old === undefined) delete process.env.PI_TEST_KEY; else process.env.PI_TEST_KEY = old; });
  process.env.PI_TEST_KEY = 'test-value';
  assert.equal(configuredApiKey('$PI_TEST_KEY'), 'test-value');
  assert.equal(configuredApiKey('${PI_TEST_KEY}'), 'test-value');
  assert.equal(configuredApiKey('literal'), 'literal');
  assert.equal(configuredApiKey(undefined), undefined);
  assert.equal(serviceApiKey(dir, 'local', ''), '');
  delete process.env.PI_TEST_KEY;
  assert.throws(() => serviceApiKey(dir, 'local', '$PI_TEST_KEY'), /Missing API key environment/);
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ local: { key: 'fixture-key' } }));
  assert.equal(serviceApiKey(dir, 'local', undefined), 'fixture-key');
});

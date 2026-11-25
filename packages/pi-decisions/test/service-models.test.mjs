import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

test('missing registry disables; each type sees only its own models', t => {
  const { dir, save, registry } = fixture(t);
  const { loadServiceConfig, modelOptions } = helper();
  const cfg = loadServiceConfig(dir, 'classifier');
  assert.deepEqual([...cfg.providers.local.models.map(m => m.id)], ['judge']);
  assert.deepEqual([...loadServiceConfig(dir, 'tts').providers.local.models.map(m => m.id)], ['voice']);
  registry.providers.local.models[0].description = 'Accurate on close calls.';
  save('service-models.json', registry);
  assert.equal(modelOptions(loadServiceConfig(dir, 'classifier')), '\n- local/judge: Accurate on close calls.');
  save('service-models.json', { providers: { local: { ...registry.providers.local, models: [registry.providers.local.models[1]] } } });
  assert.equal(loadServiceConfig(dir, 'classifier'), undefined);
  rmSync(join(dir, 'extensions', 'service-models.json'));
  assert.equal(loadServiceConfig(dir, 'classifier'), undefined);
});

test('invalid URLs and model schemas fail without leaking values', t => {
  const { dir, save, registry } = fixture(t);
  const { loadServiceConfig } = helper();
  registry.providers.local.baseUrl = 'https://user:secret@example.invalid/v1';
  save('service-models.json', registry);
  assert.throws(() => loadServiceConfig(dir, 'classifier'), error => /Invalid baseUrl/.test(error.message) && !error.message.includes('secret'));
  registry.providers.local.baseUrl = 'http://localhost:8000/v1';
  registry.providers.local.models[0].contextWindow = 0;
  save('service-models.json', registry);
  assert.throws(() => loadServiceConfig(dir, 'classifier'), /Invalid or duplicate model/);
  registry.providers.local.models[0].contextWindow = 8192;
  registry.providers.local.models[0].description = ' ';
  save('service-models.json', registry);
  assert.throws(() => loadServiceConfig(dir, 'classifier'), /Invalid or duplicate model/);
  writeFileSync(join(dir, 'extensions', 'service-models.json'), '{"secret": invalid');
  assert.throws(() => loadServiceConfig(dir, 'classifier'), error => /Malformed JSON/.test(error.message) && !error.message.includes('secret'));
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

test('example registry loads and its top-level keys are schema properties', t => {
  const { dir } = fixture(t);
  const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const example = read('../examples/service-models.example.json');
  const schema = read('../schemas/service-models.schema.json');
  assert.deepEqual(Object.keys(example).filter(key => !(key in schema.properties)), []);
  writeFileSync(join(dir, 'extensions', 'service-models.json'), JSON.stringify(example));
  assert.equal(helper().loadServiceConfig(dir, 'classifier').providers['example-services'].models.length, 1);
});

test('missing registry is created once with $schema and empty providers, and still disables', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-service-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { loadServiceConfig } = helper();
  assert.equal(loadServiceConfig(dir, 'classifier'), undefined);
  const path = join(dir, 'extensions', 'service-models.json');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    $schema: 'https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/pi-decisions/schemas/service-models.schema.json',
    providers: {},
  });
  assert.equal(loadServiceConfig(dir, 'tts'), undefined, 'the created empty registry loads without error');
  writeFileSync(path, '{"providers":{}, "keep": true}');
  loadServiceConfig(dir, 'tts');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).keep, true, 'never overwritten');
});

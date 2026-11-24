import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

test('image rewrite transmits pixels to injected service and deduplicates matching images', async () => {
  const { rewriteMessages } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'read this' },
    { type: 'image', mimeType: 'image/png', data: 'dGVzdA==' },
    { type: 'image', mimeType: 'image/png', data: 'dGVzdA==' },
  ] }];
  let count = 0;
  const fetchStub = async (url, options) => {
    count++;
    assert.equal(url, 'https://example.invalid/v1/chat/completions');
    assert.equal(JSON.parse(options.body).messages[0].content[1].image_url.url, 'data:image/png;base64,dGVzdA==');
    assert.equal(JSON.parse(options.body).stream, false);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Visible text' } }] }) };
  };
  assert.equal(await rewriteMessages(messages, [{ model: 'fixture-vision', apiKey: 'fixture-key', baseUrl: 'https://example.invalid/v1' }], fetchStub), true);
  assert.equal(count, 1);
  assert.equal(messages[0].content[1].text, '[vision model description] Visible text');
  assert.equal(messages[0].content[2].text, '[vision model description] Visible text');
});

test('failed chain produces explicit non-delivery marker without network', async () => {
  const { rewriteMessages } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
  const messages = [{ role: 'user', content: [{ type: 'image', data: 'ZmFpbA==' }] }];
  await rewriteMessages(messages, [], () => { throw new Error('unexpected network'); }, { chainError: 'fixture missing config' });
  assert.match(messages[0].content[0].text, /NOT delivered/);
});

test('model entries carry their own provider, baseUrl and thinking; legacy strings use the providers map', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pi-vision-'));
  mkdirSync(join(dir, 'extensions'));
  mkdirSync(join(dir, 'saifymatteo'));
  writeFileSync(join(dir, 'saifymatteo', '9router.json'), JSON.stringify({ baseUrl: 'https://ignored.invalid/v1' }));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ '9router': { type: 'oauth', access: 'router-key' }, omlx: { type: 'api_key', key: 'omlx-key' } }));
  writeFileSync(join(dir, 'extensions', 'vision-toolkit.json'), JSON.stringify({
    model: { provider: '9router', id: 'nous/vision:free', baseUrl: 'https://router.invalid/v1/', thinking: 'max' },
    fallbackModels: [
      { provider: 'omlx', id: 'Ling-tiny', baseUrl: 'http://localhost:8000/v1' },
      'legacy/model',
      { provider: 'nobase', id: 'x' },
    ],
    providers: { legacy: { baseUrl: 'https://legacy.invalid/v1', apiKey: 'legacy-key' } },
  }));
  const { loadVisionChain, rewriteMessages } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), {}, {
    process: { ...process, env: { PI_CODING_AGENT_DIR: dir } },
  });
  const chain = loadVisionChain();
  assert.deepEqual(JSON.parse(JSON.stringify(chain.candidates.map(c => [c.provider, c.model, c.baseUrl, c.apiKey, c.thinking ?? null]))), [
    ['9router', 'nous/vision:free', 'https://router.invalid/v1', 'router-key', 'max'],
    ['omlx', 'Ling-tiny', 'http://localhost:8000/v1', 'omlx-key', null],
    ['legacy', 'model', 'https://legacy.invalid/v1', 'legacy-key', null],
  ]);
  assert.match(chain.attempts.at(-1).error, /no baseUrl for provider "nobase"/);
  let body;
  const fetchStub = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
  await rewriteMessages([{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }] }], [chain.candidates[0]], fetchStub);
  assert.equal(body.reasoning_effort, 'high');
  await rewriteMessages([{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'b3RoZXI=' }] }], [chain.candidates[1]], fetchStub);
  assert.equal(body.reasoning_effort, undefined);
});

test('schema properties match the config keys the loader reads plus $schema', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pi-vision-schema-'));
  mkdirSync(join(dir, 'extensions'));
  const url = 'https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/pi-vision/schemas/vision-toolkit.schema.json';
  writeFileSync(join(dir, 'extensions', 'vision-toolkit.json'), JSON.stringify({ $schema: url }));
  // Record the top-level keys read from the parsed config file.
  const read = new Set();
  const json = { ...JSON, parse: (text, ...rest) => {
    const value = JSON.parse(text, ...rest);
    return value?.$schema === url ? new Proxy(value, { get: (t, k) => (read.add(k), t[k]) }) : value;
  } };
  const { loadVisionChain } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), {}, {
    process: { ...process, env: { PI_CODING_AGENT_DIR: dir } }, JSON: json,
  });
  // $schema alone is accepted and ignored: the only complaint is the missing model.
  assert.match(loadVisionChain().error, /no usable "model"/);
  const schema = JSON.parse(readFileSync(new URL('../schemas/vision-toolkit.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/pi-vision/schemas/vision-toolkit.schema.json');
  assert.deepEqual(Object.keys(schema.properties).sort(), [...read, '$schema'].sort());
});

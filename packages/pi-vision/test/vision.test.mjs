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

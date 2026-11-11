import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';
test('child process guard prevents all title hooks and registrations', () => {
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {}, {
    process: { env: { PI_CHILD: '1' } },
  });
  extension.default(new Proxy({}, { get: () => { throw new Error('child registered behavior'); } }));
  assert.equal(typeof extension.default, 'function');
});

test('model entry with baseUrl is called directly with its auth.json key, without the model registry', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pi-rename-'));
  mkdirSync(join(dir, 'extensions'));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ '9router': { type: 'oauth', access: 'router-key' } }));
  writeFileSync(join(dir, 'extensions', 'session-rename.json'), JSON.stringify({
    model: { provider: '9router', id: 'nous/title:free', thinking: 'max', baseUrl: 'https://router.invalid/v1/' },
    fallbackModels: [{ provider: 'unused', id: 'model', thinking: 'off' }],
  }));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"isNewTopic": true, "title": "Fix login bug"}' } }] }) };
  };
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {}, {
    process: { ...process, env: { PI_CODING_AGENT_DIR: dir } }, fetch,
  });
  const handlers = {};
  let name;
  let titled, failed;
  const done = new Promise((r, j) => { titled = r; failed = j; });
  extension.default({
    on: (event, fn) => { handlers[event] = fn; },
    getSessionName: () => name,
    setSessionName: n => { name = n; titled(); },
    appendEntry: () => {},
  });
  const registry = { find: () => { throw new Error('registry used'); }, hasConfiguredAuth: () => false };
  const ctx = { mode: 'tui', ui: { notify: m => failed(new Error(m)) }, modelRegistry: registry,
    sessionManager: { getHeader: () => ({}), getBranch: () => [], getSessionFile: () => undefined } };
  await handlers.session_start({}, ctx);
  await handlers.input({ text: 'the login page throws' }, ctx);
  await done;
  assert.equal(name, 'Fix login bug');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://router.invalid/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer router-key');
  assert.equal(calls[0].body.model, 'nous/title:free');
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(calls[0].body.max_tokens, 1024);
});

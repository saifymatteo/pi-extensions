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

test('herdr tab sync runs in the background, in order, and shutdown waits for the restore', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const os = await import('node:os');
  const home = mkdtempSync(join(os.tmpdir(), 'pi-rename-herdr-'));
  mkdirSync(join(home, 'agent', 'extensions'), { recursive: true });
  const calls = [];
  // A herdr that answers only when the test says so.
  const child_process = { execFile: (_cmd, args, _opts, cb) => { calls.push({ args, cb }); } };
  const answer = (i, stdout = '') => calls[i].cb(null, stdout);
  const tick = () => new Promise(r => setTimeout(r, 10));
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
    'node:child_process': child_process,
    'node:os': { ...os, homedir: () => home },
  }, { process: { ...process, env: { HERDR_ENV: '1', HERDR_TAB_ID: 't1', PI_CODING_AGENT_DIR: join(home, 'agent') } } });
  const handlers = {};
  extension.default({ on: (e, fn) => { handlers[e] = fn; }, getSessionName: () => undefined, setSessionName: () => {}, appendEntry: () => {} });
  const ctx = { mode: 'tui', ui: { notify: () => {} }, modelRegistry: {},
    sessionManager: { getHeader: () => ({}), getBranch: () => [], getSessionFile: () => undefined } };
  const started = await Promise.race([handlers.session_start({}, ctx).then(() => 'returned'), new Promise(r => setTimeout(() => r('blocked'), 500))]);
  assert.equal(started, 'returned');
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(c => c.args))), [['tab', 'get', 't1']]);
  answer(0, JSON.stringify({ result: { tab: { label: 'shell' } } }));
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].args)), ['tab', 'rename', 't1', '(no messages)']);
  const stateFile = join(home, '.pi', 'herdr-tab-state.json');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).t1, 'shell');
  answer(1);
  let shutDown = false;
  const shutdown = handlers.session_shutdown({}, ctx).then(() => { shutDown = true; });
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2].args)), ['tab', 'rename', 't1', 'shell']);
  assert.equal(shutDown, false, 'shutdown waits for the restore');
  answer(2);
  await shutdown;
  assert.equal(existsSync(stateFile), false);
});

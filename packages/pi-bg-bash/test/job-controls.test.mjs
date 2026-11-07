import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function setup({ stop = async () => 'stopped', capture = async pid => ({ pid, started: 'fixture' }), windows = false,
  launchText = '__PI_BG_PID:501 __PI_BG_WINPID:601', hasChildren = () => false } = {}) {
  const tools = new Map(), commands = new Map(), hooks = new Map(), events = new Map();
  const files = new Map(), intervals = new Set(), messages = [], statuses = [], calls = [], stopped = [];
  let controls, panelSignal;
  const processStub = { ...process, platform: windows ? 'win32' : 'linux', kill() {} };
  const builtin = () => ({ description: '', execute: async (_id, args) => {
    calls.push(args);
    return { content: [{ type: 'text', text: launchText }] };
  } });
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), {
    'node:fs': { ...fs, readdirSync: () => [], existsSync: path => files.has(path), readFileSync: path => {
      if (files.has(path)) return files.get(path);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }, writeFileSync: (path, content) => files.set(path, content) },
    './lib/process-control': { captureProcess: capture, hasTrackedDescendants: hasChildren,
      stopProcessTree: async (identity, mode) => { stopped.push({ identity, mode }); return stop(identity, mode); } },
    './lib/output': { readTail: path => files.get(path) ?? '', oneLine: text => text.replace(/\s+/g, ' ') },
    './lib/panel': { showJobPanel: async (_ctx, api, signal) => { controls = api; panelSignal = signal; } },
    '@earendil-works/pi-coding-agent': { createBashTool: builtin, createPowerShellTool: builtin },
    '@earendil-works/pi-tui': {},
  }, { process: processStub, crypto: globalThis.crypto,
    setInterval: callback => { const timer = { callback }; intervals.add(timer); return timer; },
    clearInterval: timer => intervals.delete(timer),
  });
  const pi = { registerTool: tool => tools.set(tool.name, tool), registerToolRenderer() {}, registerMessageRenderer() {},
    registerCommand: (name, options) => commands.set(name, options.handler),
    events: { on: (name, fn) => events.set(name, fn) }, on: (name, fn) => hooks.set(name, fn),
    getAllTools: () => [{ name: 'bash' }, ...(windows ? [{ name: 'powershell' }] : [])],
    sendMessage: (message, options) => messages.push({ message, options }),
  };
  const ctx = { hasUI: true, mode: 'tui', isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionFile: () => 'fixture-session', getBranch: () => [] },
    ui: { setStatus: (...args) => statuses.push(args), notify() {} },
  };
  extension(pi);
  return {
    tools, commands, hooks, files, intervals, messages, statuses, stopped, calls, ctx,
    get controls() { return controls; }, get panelSignal() { return panelSignal; },
    start: () => hooks.get('session_start')({}, ctx),
    launch: async (tool = 'bash') => {
      const result = await tools.get(tool).execute('fixture', { command: 'npm run dev', background: true }, undefined, undefined, ctx);
      const id = result.details.bgJob;
      return { id, outPath: result.details.bgOutputPath, statusPath: result.details.bgOutputPath.replace(/\.out$/, '.status') };
    },
    panel: () => commands.get('bg')('', ctx),
    claim: ids => {
      let provider;
      events.get('async-work:providers:v1')({ sessionFile: 'fixture-session', add: value => { provider = value; } });
      return provider.claim(ids, 'fixture-wait');
    },
    shutdown: () => hooks.get('session_shutdown')({ reason: 'quit' }, ctx),
  };
}

test('launch records the real platform PID and updates the running footer', async () => {
  for (const windows of [false, true]) {
    const captured = [];
    const s = setup({ windows, capture: async pid => { captured.push(pid); return { pid, started: 'fixture' }; } });
    await s.start();
    await s.launch();
    if (windows) await s.launch('powershell');
    assert.deepEqual(captured, windows ? [601, 501] : [501]);
    assert.match(s.statuses.at(-1)[1], /running.*\/bg/);
    await s.shutdown();
    assert.equal(s.statuses.at(-1)[1], undefined);
  }
});

test('Windows launch isolates both shells and clears Ctrl+C suppression before children start', async () => {
  const s = setup({ windows: true });
  await s.start();
  await s.launch();
  const launcher = Buffer.from(s.calls[0].command.match(/-EncodedCommand (\S+)/)[1], 'base64').toString('utf16le');
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.match(launcher, /-WorkingDirectory \(Get-Location\)\.ProviderPath/);
  assert.doesNotMatch(launcher, /-NoNewWindow/);
  const bashBootstrap = [...s.files].find(([path]) => path.endsWith('.ps1'))[1];
  assert.match(bashBootstrap, /SetConsoleCtrlHandler\(\[IntPtr\]::Zero, \$false\)/);
  assert.ok(bashBootstrap.indexOf('SetConsoleCtrlHandler') < bashBootstrap.indexOf('$child = [System.Diagnostics.Process]::Start'));
  assert.ok(bashBootstrap.indexOf('SetHandleInformation($inputHandle, 1, 1)') < bashBootstrap.indexOf('$child = [System.Diagnostics.Process]::Start'));
  await s.launch('powershell');
  const psBootstrap = [...s.files].filter(([path]) => path.endsWith('.ps1')).at(-1)[1];
  assert.ok(psBootstrap.indexOf('SetConsoleCtrlHandler') < psBootstrap.indexOf('npm run dev'));
  await s.shutdown();
});

test('Unix background jobs enable job control instead of inheriting ignored SIGINT', async () => {
  const s = setup();
  await s.start();
  await s.launch();
  assert.match(s.calls[0].command, /^set -m;/);
  await s.shutdown();
});

test('failed launch without a PID does not register an unmanageable forever-running job', async () => {
  const s = setup({ launchText: 'launch failed' });
  await s.start();
  await assert.rejects(s.launch(), /did not return a native PID/);
  await s.panel();
  assert.equal(s.controls.list().length, 0);
  assert.equal(s.intervals.size, 0);
  await s.shutdown();
});

test('identity discovery does not block launch; stopping waits for verification', { timeout: 1000 }, async () => {
  const identity = deferred();
  const s = setup({ capture: () => identity.promise });
  await s.start();
  const job = await s.launch();
  await s.panel();
  assert.match(s.controls.list()[0].state, /verifying PID/);
  const stopping = s.controls.stop(job.id);
  await Promise.resolve();
  assert.equal(s.stopped.length, 0);
  identity.resolve({ pid: 501, started: 'fixture' });
  await stopping;
  assert.equal(s.stopped.length, 1);
  await s.shutdown();
});

test('viewing jobs/output does not consume or claim completion; footer clears on exit', async () => {
  const s = setup();
  await s.start();
  const job = await s.launch();
  s.files.set(job.outPath, 'preview ready');
  await s.panel();
  assert.equal(s.controls.output(job.id), 'preview ready');
  assert.equal(s.controls.list()[0].state, 'running');
  const lease = s.claim([job.id]);
  s.files.set(job.statusPath, '0');
  for (const timer of s.intervals) timer.callback();
  const [result] = await lease.result;
  assert.equal(result.details.exit, '0');
  assert.equal(s.messages.length, 0);
  assert.equal(s.statuses.at(-1)[1], undefined);
  lease.commit();
  await s.shutdown();
});

test('a direct user stop is recorded without waking an idle model and remains queryable', async () => {
  const s = setup();
  await s.start();
  const job = await s.launch();
  await s.panel();
  assert.match(await s.controls.stop(job.id), /tracked process tree is gone/);
  assert.equal(s.stopped.length, 1);
  assert.equal(s.controls.list()[0].state, 'done, stopped gracefully by user');
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].options.triggerTurn, false);
  const result = await s.tools.get('bash').execute('query', { job: String(job.id) }, undefined, undefined, s.ctx);
  assert.match(result.content[0].text, /stopped gracefully by user/);
  await s.shutdown();
});

test('user stopping a wait-owned job resolves the lease once without duplicate delivery', async () => {
  const s = setup();
  await s.start();
  const job = await s.launch();
  const lease = s.claim([job.id]);
  await s.panel();
  await s.controls.stop(job.id);
  const results = await lease.result;
  assert.equal(results.length, 1);
  assert.equal(results[0].details.exit, 'stopped gracefully by user');
  assert.equal(s.messages.length, 0);
  lease.commit();
  lease.release();
  assert.equal(s.messages.length, 0);
  await s.shutdown();
});

test('releasing a stopped job restores exactly one automatic delivery', async () => {
  const s = setup();
  await s.start();
  const job = await s.launch();
  const lease = s.claim([job.id]);
  await s.panel();
  await s.controls.stop(job.id);
  await lease.result;
  lease.release();
  lease.release();
  assert.equal(s.messages.length, 1);
  await s.shutdown();
});

test('concurrent user and agent stop share one operation and preserve the wait result', { timeout: 1000 }, async () => {
  const operation = deferred(), entered = deferred();
  const s = setup({ stop: () => { entered.resolve(); return operation.promise; } });
  await s.start();
  const job = await s.launch();
  const lease = s.claim([job.id]);
  await s.panel();
  const first = s.controls.stop(job.id);
  const second = s.tools.get('bash').execute('stop', { job: `${job.id}:stop` }, undefined, undefined, s.ctx);
  await entered.promise;
  assert.equal(s.stopped.length, 1);
  assert.equal(s.controls.list()[0].state, 'stopping gracefully');
  operation.resolve('stopped');
  await Promise.all([first, second]);
  assert.equal((await lease.result)[0].details.exit, 'stopped gracefully by user');
  lease.commit();
  await s.shutdown();
});

test('force requested during graceful stopping queues a real force operation without duplicating completion', { timeout: 1000 }, async () => {
  const graceful = deferred(), entered = deferred();
  const s = setup({ stop: (_identity, mode) => {
    if (mode === 'graceful') { entered.resolve(); return graceful.promise; }
    return 'stopped';
  } });
  await s.start();
  const job = await s.launch();
  const lease = s.claim([job.id]);
  await s.panel();
  const first = s.controls.stop(job.id, 'graceful');
  const failed = assert.rejects(first, /Force kill/);
  await entered.promise;
  const force = s.tools.get('bash').execute('kill', { job: `${job.id}:kill` }, undefined, undefined, s.ctx);
  assert.equal(s.stopped.length, 1);
  graceful.resolve('stuck');
  await failed;
  await force;
  assert.deepEqual(s.stopped.map(call => call.mode), ['graceful', 'force']);
  assert.equal((await lease.result)[0].details.exit, 'force killed by agent');
  assert.equal(s.messages.length, 0);
  lease.commit();
  await s.shutdown();
});

test('force stop is explicit, recorded without idle wakeup and never masquerades as graceful', async () => {
  const s = setup();
  await s.start();
  const job = await s.launch();
  await s.panel();
  await s.controls.stop(job.id, 'force');
  assert.equal(s.stopped[0].mode, 'force');
  assert.equal(s.controls.list()[0].state, 'done, force killed by user');
  assert.equal(s.messages[0].options.triggerTurn, false);
  await s.shutdown();
});

test('failed or unverifiable stops retain jobs and allow safe retry', async () => {
  let attempt = 0;
  const s = setup({ stop: async () => ++attempt === 1 ? 'stuck' : 'stopped' });
  await s.start();
  const job = await s.launch();
  await s.panel();
  await assert.rejects(s.controls.stop(job.id), /still running/);
  s.files.set(job.statusPath, '143'); // The launcher exited, but a child survived cleanup.
  for (const timer of s.intervals) timer.callback();
  assert.equal(s.controls.list()[0].running, true);
  assert.equal(s.controls.list()[0].state, 'cleanup incomplete');
  assert.equal(s.messages.length, 0);
  await s.controls.stop(job.id, 'force');
  assert.equal(s.stopped.length, 2);
  assert.deepEqual(s.stopped.map(call => call.mode), ['graceful', 'force']);
  await s.shutdown();

  const unavailable = setup({ capture: async () => { throw new Error('access denied'); } });
  await unavailable.start();
  const unknown = await unavailable.launch();
  await unavailable.panel();
  await assert.rejects(unavailable.controls.stop(unknown.id), /access denied/);
  assert.equal(unavailable.stopped.length, 0);
  assert.match(unavailable.controls.list()[0].state, /stop unavailable/);
  await unavailable.shutdown();
});

test('completed commands can clean known children without changing or duplicating their wait result', async () => {
  let children = true;
  const s = setup({ hasChildren: () => children, stop: async () => { children = false; return 'stopped'; } });
  await s.start();
  const job = await s.launch();
  const lease = s.claim([job.id]);
  s.files.set(job.statusPath, '0');
  for (const timer of s.intervals) timer.callback();
  assert.equal((await lease.result)[0].details.exit, '0');
  await s.panel();
  assert.equal(s.controls.list()[0].running, false);
  assert.equal(s.controls.list()[0].stoppable, true);
  assert.match(s.controls.list()[0].state, /child cleanup available/);
  const cleanup = await s.tools.get('bash').execute('cleanup', { job: `${job.id}:kill` }, undefined, undefined, s.ctx);
  assert.match(cleanup.content[0].text, /command result is unchanged/);
  assert.equal(s.controls.list()[0].stoppable, false);
  assert.equal((await lease.result)[0].details.exit, '0');
  assert.equal(s.messages.length, 0);
  lease.commit();
  await s.shutdown();
});

test('history trimming retains completed commands with unverified child cleanup', async () => {
  const s = setup({ hasChildren: () => true });
  await s.start();
  for (let i = 0; i < 23; i++) {
    const job = await s.launch();
    const lease = s.claim([job.id]);
    s.files.set(job.statusPath, '0');
    for (const timer of s.intervals) timer.callback();
    await lease.result;
    lease.commit();
  }
  await s.panel();
  assert.equal(s.controls.list().length, 23);
  assert.ok(s.controls.list().every(job => job.stoppable && !job.running));
  await s.shutdown();
});

test('already-finished jobs receive no stop signal', async () => {
  const s = setup();
  await s.start();
  const job = await s.launch();
  s.files.set(job.statusPath, '0');
  await s.panel();
  assert.match(await s.controls.stop(job.id), /already finished/);
  assert.equal(s.stopped.length, 0);
  await s.shutdown();
});

test('shutdown closes panel scope and drains only previously requested stops', async () => {
  const operation = deferred();
  const s = setup({ stop: () => operation.promise });
  await s.start();
  const job = await s.launch();
  await s.launch();
  await s.panel();
  const stopping = s.controls.stop(job.id);
  let drained = false;
  const shutdown = s.shutdown().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(s.panelSignal.aborted, true);
  assert.equal(drained, false);
  operation.resolve('stopped');
  await Promise.all([stopping, shutdown]);
  assert.equal(s.stopped.length, 1);
  assert.equal(s.messages.length, 0);
  assert.equal(s.intervals.size, 0);
  await assert.rejects(s.controls.stop(job.id), /no longer available/);
});

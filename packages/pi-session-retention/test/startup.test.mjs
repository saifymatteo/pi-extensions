import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, realpath, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { loadExtension } from '../../../test/load-extension.mjs';
import * as core from '../src/core.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function harness(t, { old = false, state, holdScan = false, scanError = false } = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'pi-retention-startup-'));
  const root = join(dir, 'sessions');
  const file = join(root, 'session.jsonl');
  const now = Date.now();
  const stamp = old ? now - core.RETENTION_MS - 60_000 : now;
  await mkdir(root);
  await writeFile(file, JSON.stringify({ type: 'session', id: 'fixture', timestamp: new Date(stamp).toISOString() }) + '\n');
  await utimes(file, new Date(stamp), new Date(stamp));
  const entered = deferred(), release = deferred(), finished = deferred(), notified = deferred();
  const timers = new Map(), hooks = {}, commands = {}, notifications = [], confirmations = [];
  let scans = 0, probes = 0, nextTimer = 0;
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
    './core.ts': {
      ...core,
      RetentionStore: class extends core.RetentionStore {
        async scan(options) {
          scans++;
          entered.resolve();
          if (holdScan) await release.promise;
          if (scanError) throw new Error('fixture scan failed');
          return super.scan(options);
        }
      },
    },
  }, {
    performance,
    setTimeout: callback => { const id = { id: ++nextTimer, unref() {} }; timers.set(id, callback); return id; },
    clearTimeout: id => { timers.delete(id); },
  });
  extension.default({
    on: (name, handler) => { hooks[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
  }, { now: () => now, guard: async () => { probes++; } });
  const ctx = {
    mode: 'tui',
    idle: true,
    isIdle() { return this.idle; },
    sessionManager: { getSessionDir: () => root, getCwd: () => dir, getSessionFile: () => join(root, 'active.jsonl') },
    waitForIdle: async () => {},
    ui: {
      custom: async () => undefined,
      setStatus: (_key, text) => { if (text === undefined) finished.resolve(); },
      notify: (text, level) => { notifications.push({ text, level }); notified.resolve(); },
      confirm: async (...args) => { confirmations.push(args); return true; },
    },
  };
  const { trash } = extension.storePaths(ctx);
  if (state) {
    await mkdir(trash, { recursive: true });
    await writeFile(join(trash, 'settings.json'), JSON.stringify({ approved: true, paused: false, lastRun: 0, ...state }));
  }
  t.after(async () => {
    release.resolve();
    await hooks.session_shutdown({}, ctx);
    await rm(dir, { recursive: true, force: true });
  });
  return {
    ctx, hooks, commands, timers, notifications, confirmations, file, trash, now, entered, release, finished, notified,
    get scans() { return scans; },
    get probes() { return probes; },
    runTimer() {
      assert.equal(timers.size, 1);
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test('startup returns before scanning; shutdown drains background work before releasing its lock', async t => {
  const h = await harness(t, { holdScan: true });
  assert.equal(h.hooks.session_start({}, h.ctx), undefined);
  assert.equal(h.scans, 0);
  assert.equal(h.timers.size, 1);
  h.hooks.session_start({}, h.ctx);
  assert.equal(h.timers.size, 1);
  h.runTimer();
  await h.entered.promise;
  assert.equal(h.hooks.session_before_switch({}, h.ctx).cancel, true);
  assert.equal(h.hooks.session_before_fork({}, h.ctx).cancel, true);
  let stopped = false;
  const shutdown = h.hooks.session_shutdown({}, h.ctx).then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  await access(join(h.trash, '.maintenance.lock'));
  h.release.resolve();
  await shutdown;
  await assert.rejects(access(join(h.trash, '.maintenance.lock')), { code: 'ENOENT' });
  assert.equal(h.notifications.some(item => item.level === 'warning' && /aborted/i.test(item.text)), false);
});

test('busy startup defers until agent_settled and never schedules duplicate scans', async t => {
  const h = await harness(t);
  h.ctx.idle = false;
  h.hooks.session_start({}, h.ctx);
  h.runTimer();
  assert.equal(h.scans, 0);
  assert.equal(h.timers.size, 0);
  h.ctx.idle = true;
  h.hooks.agent_settled({}, h.ctx);
  h.hooks.agent_settled({}, h.ctx);
  h.runTimer();
  await h.finished.promise;
  assert.equal(h.scans, 1);
  h.hooks.agent_settled({}, h.ctx);
  assert.equal(h.timers.size, 0);
});

test('automatic discovery notifies instead of opening approval; explicit cleanup can approve', async t => {
  const h = await harness(t, { old: true });
  h.hooks.session_start({}, h.ctx);
  h.runTimer();
  await h.finished.promise;
  assert.equal(h.confirmations.length, 0);
  assert.ok(h.notifications.some(item => /\/session-cleanup/.test(item.text)));
  await access(h.file);
  assert.equal(h.probes, 0);
  const state = JSON.parse(await readFile(join(h.trash, 'settings.json'), 'utf8'));
  assert.equal(state.approved, false);
  assert.equal(state.lastRun, h.now);
  await h.commands['session-cleanup'].handler('', h.ctx);
  assert.equal(h.confirmations.length, 1);
  assert.deepEqual(h.notifications.filter(item => item.level === 'error'), []);
  assert.ok(h.probes > 0);
  await assert.rejects(access(h.file), { code: 'ENOENT' });
});

test('previously approved automatic cleanup still moves eligible sessions without a dialog', async t => {
  const h = await harness(t, { old: true, state: {} });
  h.hooks.session_start({}, h.ctx);
  h.runTimer();
  await h.finished.promise;
  assert.equal(h.confirmations.length, 0);
  assert.deepEqual(h.notifications.filter(item => item.level === 'warning'), []);
  assert.ok(h.probes > 0);
  await assert.rejects(access(h.file), { code: 'ENOENT' });
});

test('daily and paused settings still skip scans in the background', async t => {
  for (const state of [{ lastRun: Date.now() }, { paused: true }]) {
    await t.test(JSON.stringify(state), async t => {
      const h = await harness(t, { state });
      h.hooks.session_start({}, h.ctx);
      h.runTimer();
      await h.finished.promise;
      assert.equal(h.scans, 0);
      assert.equal(h.probes, 0);
    });
  }
});

test('shutdown cancels queued maintenance and a new session can schedule again', async t => {
  const h = await harness(t);
  h.hooks.session_start({}, h.ctx);
  await h.hooks.session_shutdown({}, h.ctx);
  assert.equal(h.timers.size, 0);
  assert.equal(h.scans, 0);
  h.hooks.session_start({}, h.ctx);
  h.runTimer();
  await h.entered.promise;
  await h.hooks.session_shutdown({}, h.ctx);
  assert.equal(h.scans, 1);
});

test('explicit maintenance cancels queued automatic work', async t => {
  for (const [command, args] of [['session-cleanup', 'pause'], ['session-trash', '']]) {
    await t.test(command, async t => {
      const h = await harness(t);
      h.hooks.session_start({}, h.ctx);
      await h.commands[command].handler(args, h.ctx);
      assert.equal(h.timers.size, 0);
      h.hooks.agent_settled({}, h.ctx);
      assert.equal(h.timers.size, 0);
      assert.equal(h.scans, 0);
      assert.deepEqual(h.notifications.filter(item => item.level === 'error'), []);
    });
  }
});

test('non-TUI modes and sessions without a file schedule no maintenance', async t => {
  const h = await harness(t);
  for (const mode of ['print', 'json', 'rpc']) {
    h.ctx.mode = mode;
    h.hooks.session_start({}, h.ctx);
    assert.equal(h.timers.size, 0);
  }
  h.ctx.mode = 'tui';
  h.ctx.sessionManager.getSessionFile = () => undefined;
  h.hooks.session_start({}, h.ctx);
  assert.equal(h.timers.size, 0);
});

test('background failures are reported and release the maintenance lock', async t => {
  const h = await harness(t, { scanError: true });
  h.hooks.session_start({}, h.ctx);
  h.runTimer();
  await h.notified.promise;
  await h.hooks.session_shutdown({}, h.ctx);
  assert.ok(h.notifications.some(item => /fixture scan failed/.test(item.text)));
  await assert.rejects(access(join(h.trash, '.maintenance.lock')), { code: 'ENOENT' });
});

test('a failed UI notification cannot cause an unhandled background rejection', async t => {
  const h = await harness(t, { scanError: true });
  const notify = h.ctx.ui.notify;
  h.ctx.ui.notify = (...args) => { notify(...args); throw new Error('fixture UI failed'); };
  h.hooks.session_start({}, h.ctx);
  h.runTimer();
  await h.notified.promise;
  // Give detached promise rejections a turn to surface in the test runner.
  await setImmediate();
  await assert.rejects(access(join(h.trash, '.maintenance.lock')), { code: 'ENOENT' });
});

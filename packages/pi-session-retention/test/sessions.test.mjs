import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, realpath, utimes, symlink } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SessionRegistry } from '../src/sessions.ts';
import * as safety from '../src/safety.ts';
import { RetentionStore, RETENTION_MS } from '../src/core.ts';
import { loadExtension } from '../../../test/load-extension.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'pi-retention-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = join(dir, 'registry'), root = join(dir, 'sessions');
  await mkdir(root);
  const own = { pid: process.pid, name: 'pi-bolt', command: '', started: 'own-start' };
  const peer = { pid: process.pid + 1, name: 'pi', command: '', started: 'peer-start' };
  const state = { processes: [own, peer], clock: 0 };
  const makeRegistry = pid => new SessionRegistry(directory, { pid, snapshot: async () => state.processes, clock: () => state.clock });
  const registry = makeRegistry(own.pid), other = makeRegistry(peer.pid);
  const now = Date.now(), old = now - RETENTION_MS - 60_000;
  async function session(name, parentSession) {
    const path = join(root, `${name}.jsonl`);
    await writeFile(path, JSON.stringify({ type: 'session', id: name, timestamp: new Date(old).toISOString(), ...(parentSession ? { parentSession } : {}) }) + '\n');
    await utimes(path, new Date(old), new Date(old));
    return path;
  }
  return { dir, root, directory, own, peer, state, registry, other, makeRegistry, session, now };
}

function host(f, active) {
  const hooks = {}, commands = {}, notifications = [], confirmations = [];
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {}, { performance });
  extension.default({
    on: (name, handler) => { hooks[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
  }, { sessions: f.registry, now: () => f.now });
  const ctx = {
    mode: 'tui', isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getSessionDir: () => f.root, getCwd: () => f.dir, getSessionFile: () => active },
    ui: {
      setStatus() {}, notify: (text, level) => notifications.push({ text, level }),
      confirm: async (...args) => { confirmations.push(args); return true; },
    },
  };
  return { hooks, commands, notifications, confirmations, ctx, trash: extension.storePaths(ctx).trash };
}

test('cleanup with multiple open instances skips both active families and trashes an unrelated old family', async t => {
  const f = await fixture(t);
  const own = await f.session('own');
  const parent = await f.session('peer-parent');
  const child = await f.session('peer-child', parent);
  const unrelated = await f.session('unrelated');
  await f.other.register([child]);
  const h = host(f, own);
  await h.commands['session-cleanup'].handler('', h.ctx);
  assert.deepEqual(h.notifications.filter(item => item.level === 'error'), []);
  for (const path of [own, parent, child]) await access(path);
  await assert.rejects(access(unrelated), { code: 'ENOENT' });
  assert.match(h.notifications.at(-1).text, /1 sessions moved to Trash/);
  const batches = await new RetentionStore(f.root, h.trash).listTrash();
  assert.deepEqual(batches.batches[0].manifest.files.map(file => file.original), ['unrelated.jsonl']);
});

test('PID zero in the OS inventory does not warn on startup or fail cleanup preview', async t => {
  const f = await fixture(t);
  const own = await f.session('own'), peer = await f.session('peer'), old = await f.session('old');
  await f.other.register([peer]);
  // Win32_Process includes this real system entry; it is not a Pi instance and
  // has no registration or process-start identity that retention needs to read.
  f.state.processes.unshift({ pid: 0, name: 'System Idle Process', command: '' });
  let registering;
  const register = f.registry.register.bind(f.registry);
  f.registry.register = (...args) => (registering = register(...args));
  const h = host(f, own);
  h.ctx.isIdle = () => false; // Keep automatic maintenance out of this preview check.
  try {
    h.hooks.session_start({}, h.ctx);
    await registering.catch(() => {});
    await h.commands['session-cleanup'].handler('preview', h.ctx);
    assert.deepEqual(h.notifications, []);
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.confirmations[0][0], 'Preview only — nothing will be changed');
    assert.match(h.confirmations[0][1], /1 inactive families \(1 sessions\)/);
    for (const path of [own, peer, old]) await access(path);
    await assert.rejects(access(join(h.trash, 'settings.json')), { code: 'ENOENT' });
  } finally { await h.hooks.session_shutdown({}, h.ctx); }
});

test('an unsaved fork protects its on-disk parent family before the child file exists', async t => {
  const f = await fixture(t);
  const own = await f.session('own');
  const ancestor = await f.session('ancestor');
  const parent = await f.session('parent', ancestor);
  const sibling = await f.session('sibling', ancestor);
  const unrelated = await f.session('unrelated');
  const peer = host({ ...f, registry: f.other }, join(f.root, 'unsaved-child.jsonl'));
  peer.ctx.sessionManager.getHeader = () => ({ parentSession: parent });
  await peer.hooks.session_before_fork({}, peer.ctx);
  const h = host(f, own);
  await h.commands['session-cleanup'].handler('', h.ctx);
  assert.deepEqual(h.notifications.filter(item => item.level === 'error'), []);
  for (const path of [ancestor, parent, sibling]) await access(path);
  await assert.rejects(access(unrelated), { code: 'ENOENT' });
});

test('a separate process publishes protection and cannot change sessions while maintenance holds the gate', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const childFile = join(f.dir, 'child.mjs');
  await writeFile(childFile, `
    import { SessionRegistry } from ${JSON.stringify(new URL('../src/sessions.ts', import.meta.url).href)};
    const registry = new SessionRegistry(process.argv[2], {
      snapshot: async () => [{ pid: process.pid, name: 'pi', command: '', started: 'child-start' }],
    });
    process.on('message', async message => {
      try { await registry.register(message.paths); process.send({ ok: true }); }
      catch (error) { process.send({ error: error.message }); }
    });
    process.send({ ready: true });
  `);
  const child = fork(childFile, [f.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  assert.equal((await once(child, 'message'))[0].ready, true);
  const peer = await f.session('child-session');
  const request = async paths => { const response = once(child, 'message'); child.send({ paths }); return (await response)[0]; };
  assert.equal((await request([peer])).ok, true);
  f.state.processes = [f.own, { pid: child.pid, name: 'pi', command: '', started: 'child-start' }];
  await f.registry.register([]);
  await f.registry.maintain(async paths => {
    assert.ok((await paths()).includes(peer));
    assert.match((await request([])).error, /already running/);
  });
  assert.equal((await request([])).ok, true);
  assert.deepEqual(await f.registry.maintain(paths => paths()), []);
});

test('an unknown Pi process defers cleanup without moving sessions or granting approval', async t => {
  const f = await fixture(t);
  const own = await f.session('own'), old = await f.session('old');
  const h = host(f, own);
  await h.commands['session-cleanup'].handler('', h.ctx);
  assert.match(h.notifications.at(-1).text, /no verifiable session registration/);
  assert.equal(h.confirmations.length, 0);
  await access(old);
  await assert.rejects(access(join(h.trash, 'settings.json')), { code: 'ENOENT' });
});

test('registrations have no idle timeout, ignore exited processes and reject PID reuse', async t => {
  const f = await fixture(t);
  await f.registry.register([join(f.root, 'own.jsonl')]);
  await f.other.register([join(f.root, 'peer.jsonl')]);
  f.state.clock = 365 * 24 * 60 * 60 * 1000;
  assert.equal((await f.registry.maintain(paths => paths())).length, 2);
  f.state.processes = [f.own];
  assert.equal((await f.registry.maintain(paths => paths())).length, 1);
  f.state.processes = [f.own, { ...f.peer, started: 'reused-pid' }];
  await assert.rejects(f.registry.maintain(paths => paths()), /no verifiable session registration/);
});

test('malformed, relative, oversized and symlink registrations fail closed', async t => {
  const f = await fixture(t);
  await f.registry.register([]);
  const path = join(f.directory, `${f.peer.pid}.json`);
  for (const content of ['{', JSON.stringify({ version: 1, pid: f.peer.pid, started: f.peer.started, paths: ['relative.jsonl'] }), ' '.repeat(65537)]) {
    await writeFile(path, content);
    await assert.rejects(f.registry.maintain(paths => paths()), /no verifiable/);
  }
  await rm(path);
  const target = join(f.dir, 'target.json');
  await writeFile(target, JSON.stringify({ version: 1, pid: f.peer.pid, started: f.peer.started, paths: [] }));
  try { await symlink(target, path); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(f.registry.maintain(paths => paths()), /no verifiable/);
  await assert.rejects(f.other.register([]), /Unsafe session registration/);
});

test('inventory failures, duplicate PIDs and missing start times fail closed', async t => {
  const f = await fixture(t);
  await f.registry.register([]);
  f.state.processes = [];
  await assert.rejects(f.registry.maintain(paths => paths()), /Cannot verify/);
  for (const pid of [-1, 1.5, NaN, undefined, null, '7']) {
    f.state.processes = [f.own, { ...f.peer, pid }];
    await assert.rejects(f.registry.maintain(paths => paths()), /Invalid process inventory/);
  }
  for (const entries of [[f.own, f.own], [f.own, { pid: 0 }, { pid: 0 }]]) {
    f.state.processes = entries;
    await assert.rejects(f.registry.maintain(paths => paths()), /Invalid process inventory/);
  }
  f.state.processes = [f.own, { ...f.peer, started: undefined }];
  await assert.rejects(f.registry.maintain(paths => paths()), /no verifiable/);
  const failing = new SessionRegistry(f.directory, { snapshot: async () => { throw new Error('inventory unavailable'); } });
  await assert.rejects(failing.register([]), /inventory unavailable/);
  await assert.rejects(failing.maintain(paths => paths()), /inventory unavailable/);
});

test('maintenance excludes registration and session changes, releasing the gate after failure', async t => {
  const f = await fixture(t);
  const own = await f.session('own'), peer = await f.session('peer'), target = await f.session('target');
  await f.registry.register([own]);
  await f.other.register([peer]);
  // A real second adapter, not a mocked switch guard, sees the shared gate.
  const h = host({ ...f, registry: f.other }, peer);
  await assert.rejects(f.registry.maintain(async paths => {
    await paths();
    await assert.rejects(f.other.register([peer, target]), /already running/);
    assert.equal((await h.hooks.session_before_switch({ targetSessionFile: target }, h.ctx)).cancel, true);
    assert.equal((await h.hooks.session_before_fork({}, h.ctx)).cancel, true);
    throw new Error('fixture failure');
  }), /fixture failure/);
  await assert.rejects(access(join(f.directory, '.registry.lock')), { code: 'ENOENT' });
  assert.equal(await h.hooks.session_before_switch({ targetSessionFile: target }, h.ctx), undefined);
  const paths = await f.registry.maintain(paths => paths());
  assert.ok(paths.includes(peer));
  assert.ok(paths.includes(target));
});

test('a cancelled switch conservatively retains both families through later cleanup', async t => {
  const f = await fixture(t);
  f.state.processes = [f.own];
  const own = await f.session('own'), target = await f.session('target'), old = await f.session('old');
  const h = host(f, own);
  assert.equal(await h.hooks.session_before_switch({ targetSessionFile: target }, h.ctx), undefined);
  // Simulate a later extension cancelling the switch; no shutdown/start follows.
  await h.commands['session-cleanup'].handler('', h.ctx);
  assert.deepEqual(h.notifications.filter(item => item.level === 'error'), []);
  await access(own); await access(target);
  await assert.rejects(access(old), { code: 'ENOENT' });
  // Import destinations may not exist yet when the host emits the switch hook.
  assert.equal(await h.hooks.session_before_switch({ targetSessionFile: join(f.root, 'import.jsonl') }, h.ctx), undefined);
});

test('switch intent protects the target family before another window scans it', async t => {
  const f = await fixture(t);
  const own = await f.session('own'), peer = await f.session('peer');
  const parent = await f.session('target-parent'), target = await f.session('target-child', parent);
  await f.registry.register([own]);
  const h = host({ ...f, registry: f.other }, peer);
  await h.hooks.session_before_switch({ targetSessionFile: target }, h.ctx);
  const candidates = await f.registry.maintain(async paths => new RetentionStore(f.root, join(f.dir, 'trash')).scan({ now: f.now, protectedPaths: await paths() }));
  assert.deepEqual(candidates.candidates, []);
});

test('new unregistered processes are detected at the next bounded inventory refresh', async t => {
  const f = await fixture(t);
  f.state.processes = [f.own];
  await f.registry.register([]);
  await f.registry.maintain(async paths => {
    await paths();
    f.state.processes = [f.own, f.peer];
    f.state.clock = 999;
    await paths();
    f.state.clock = 1000;
    await assert.rejects(paths(), /no verifiable/);
    // Failed inventories cannot be cached as successes.
    await assert.rejects(paths(), /no verifiable/);
  });
});

test('startup registration retries contention and can be aborted during the wait', async t => {
  const f = await fixture(t);
  for (const abort of [false, true]) {
    let attempts = 0, entered;
    const attempted = new Promise(resolve => { entered = resolve; });
    const { SessionRegistry: RetryingRegistry } = loadExtension(new URL('../src/sessions.ts', import.meta.url), {
      './safety.ts': {
        ...safety,
        withLock: (...args) => {
          attempts++;
          if (attempts === 1 || abort) { entered(); throw new safety.RetentionBusyError('fixture busy'); }
          return safety.withLock(...args);
        },
      },
    });
    const controller = new AbortController();
    const registry = new RetryingRegistry(f.directory, { snapshot: async () => [f.own] });
    const registering = registry.register([], controller.signal);
    await attempted;
    if (abort) {
      controller.abort();
      await assert.rejects(registering, /abort/i);
      assert.equal(attempts, 1);
    } else {
      await registering;
      assert.equal(attempts, 2);
    }
  }
});

test('process snapshots parse Unix start identities and Windows creation ticks', async () => {
  const examples = [
    { platform: 'linux', output: ' 7 Sat Nov  7 16:00:00 2026 /usr/bin/pi-bolt pi-bolt --session test.jsonl\\n', started: 'Sat Nov 7 16:00:00 2026', name: 'pi-bolt' },
    { platform: 'darwin', output: ' 7 Sat Nov  7 16:00:00 2026 pi pi --session test.jsonl\\n', started: 'Sat Nov 7 16:00:00 2026', name: 'pi' },
    { platform: 'win32', output: JSON.stringify([{ ProcessId: 7, Name: 'pi.exe', CommandLine: 'pi.exe', Started: '123456789' }]), started: '123456789', name: 'pi.exe' },
  ];
  for (const example of examples) {
    const execFile = () => {};
    execFile[promisify.custom] = async () => ({ stdout: example.output, stderr: '' });
    const { processSnapshot } = loadExtension(new URL('../src/safety.ts', import.meta.url), {
      'node:child_process': { execFile },
    }, { process: { platform: example.platform, env: {} } });
    const result = await processSnapshot();
    assert.equal(result[0].pid, 7);
    assert.equal(result[0].name, example.name);
    assert.equal(result[0].started, example.started);
  }
});

test('a lock owner is fully initialized before publication to competing startup registrations', async t => {
  const f = await fixture(t);
  let entered, release;
  const reachedStat = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const gated = loadExtension(new URL('../src/safety.ts', import.meta.url), {
    'node:fs/promises': {
      ...fs,
      open: async (...args) => {
        const file = await fs.open(...args);
        return new Proxy(file, { get(target, key) {
          if (key === 'stat') return async () => { entered(); await resume; return file.stat(); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    },
  });
  const acquiring = gated.withLock(f.directory, async () => {}, '.registry.lock');
  try {
    await reachedStat;
    await assert.rejects(access(join(f.directory, '.registry.lock')), { code: 'ENOENT' });
    await f.registry.register([], new AbortController().signal);
  } finally { release(); await acquiring; }
  await assert.rejects(access(join(f.directory, '.registry.lock')), { code: 'ENOENT' });
});

test('lock staging metadata is not interpreted as a Trash batch', async t => {
  const f = await fixture(t);
  const trash = join(f.dir, 'trash');
  await mkdir(trash);
  await writeFile(join(trash, '.lock-12345678-1234-1234-1234-123456789abc.tmp'), '{}');
  const result = await new RetentionStore(f.root, trash).listTrash();
  assert.deepEqual(result, { batches: [], issues: [] });
});

test('lock release refuses to unlink a replaced lock file', async t => {
  const f = await fixture(t);
  const path = join(f.directory, '.maintenance.lock');
  await assert.rejects(safety.withLock(f.directory, async () => {
    await rm(path);
    await writeFile(path, JSON.stringify({ pid: process.pid, replacement: true }));
  }), /lock changed/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).replacement, true);
});

test('purge and restore guards refuse a session opened from Trash', async t => {
  const f = await fixture(t);
  const old = await f.session('old');
  const h = host(f, join(f.root, 'current.jsonl'));
  const store = new RetentionStore(f.root, h.trash);
  const manifest = await store.trashFamily((await store.scan({ now: f.now })).candidates[0], { now: f.now, guard: async () => true });
  const stored = join(store.trashRoot, manifest.id, '0.jsonl');
  await f.registry.register([]);
  await f.other.register([stored]);
  const later = host({ ...f, now: f.now + RETENTION_MS + 1 }, join(f.root, 'current.jsonl'));
  await later.commands['session-cleanup'].handler('', later.ctx);
  assert.ok(later.notifications.some(item => /Refusing to move or delete an open session/.test(item.text)));
  h.ctx.ui.custom = async () => manifest.id;
  await h.commands['session-trash'].handler('', h.ctx);
  assert.match(h.notifications.at(-1).text, /Refusing to move or delete an open session/);
  assert.equal((await store.listTrash()).batches[0].manifest.ready, true);
  await access(stored);
  await assert.rejects(access(old), { code: 'ENOENT' });
  const record = JSON.parse(await readFile(join(f.directory, `${f.peer.pid}.json`), 'utf8'));
  assert.equal(record.started, f.peer.started);
});

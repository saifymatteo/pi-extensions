import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, realpath, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionStore, RETENTION_MS } from '../src/core.ts';
import { TrashSearchCache } from '../src/search-cache.ts';
import { SessionRegistry } from '../src/sessions.ts';
import { loadExtension } from '../../../test/load-extension.mjs';
import * as nativeTui from '@earendil-works/pi-tui';
import { setImmediate } from 'node:timers/promises';
import { markdownHost } from './ui-theme.mjs';
const { SessionTrashDialog } = loadExtension(new URL('../src/dialog.ts', import.meta.url), { '@earendil-works/pi-tui': nativeTui, '@earendil-works/pi-coding-agent': markdownHost });

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { count = 2, hold = false, failure = false, removeFailure = false, realDialog = false, previewHold = false, approved = true } = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'pi-trash-loading-'));
  const root = join(dir, 'sessions'), registryDirectory = join(dir, 'registry');
  await mkdir(root);
  const now = Date.now();
  const hooks = {}, commands = {}, notifications = [], confirmations = [], reads = [], updates = [], removals = [], previewRequests = [], previewFrames = [];
  let gate = deferred(), mounted = deferred(), entered = deferred(), indexed = deferred(), previewGate = deferred(), previewEntered = deferred(), previewFailed = deferred(), finish, component;
  const f = { now, hold, failure, removeFailure, previewHold, approved };
  class Cache extends TrashSearchCache {
    async read(batch, signal) {
      reads.push(batch.manifest.id);
      entered.resolve();
      if (f.hold) await gate.promise;
      signal.throwIfAborted();
      if (f.failure) throw new Error('fixture metadata unavailable');
      return super.read(batch, signal);
    }
    async remove(ids) {
      removals.push(...ids);
      if (f.removeFailure) throw new Error('fixture cache removal failed');
      return super.remove(ids);
    }
  }
  class Dialog {
    constructor(_tui, _theme, _kb, choices, query, done) {
      this.choices = structuredClone(choices);
      this.query = query;
      this.done = done;
    }
    update(choices, progress) {
      this.choices = structuredClone(choices);
      updates.push({ choices: this.choices, progress });
      if (progress.completed === progress.total) indexed.resolve();
    }
  }
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
    './search-cache.ts': { TrashSearchCache: Cache },
    './preview.ts': { loadTrashPreview: async (root, batch, member, signal) => {
      previewRequests.push({ root, batch, member, signal });
      previewEntered.resolve();
      if (f.previewHold) await previewGate.promise;
      signal.throwIfAborted();
      return { name: 'Preview fixture', cwd: dir, firstRequest: 'Preview first request', recent: [], truncated: false };
    } },
  }, { performance });
  extension.default({ on: (name, handler) => { hooks[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; } }, {
    now: () => f.now, dialog: realDialog ? SessionTrashDialog : Dialog,
    sessions: new SessionRegistry(registryDirectory, { snapshot: async () => [{ pid: process.pid, name: 'pi', command: '', started: 'fixture' }] }),
  });
  const ctx = {
    mode: 'tui', isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getSessionDir: () => root, getCwd: () => dir, getSessionFile: () => join(root, 'current.jsonl') },
    ui: {
      setStatus() {}, notify: (text, level) => notifications.push({ text, level }),
      confirm: async (...args) => { confirmations.push(args); return f.approved; },
      custom: async factory => {
        const answer = deferred();
        component = await factory({ terminal: { rows: 24 }, requestRender() {
          const frame = (component?.render?.(110) ?? []).join('\n');
          previewFrames.push(frame);
          if (frame.includes('Preview unavailable')) previewFailed.resolve();
        } }, { fg: (_color, text) => text, bg: (_color, text) => text }, { matches: (data, action) => ({ 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b' })[action] === data }, value => answer.resolve(value));
        finish = component.done;
        mounted.resolve();
        return answer.promise;
      },
    },
  };
  const trash = extension.storePaths(ctx).trash;
  const store = new RetentionStore(root, trash);
  for (let i = 0; i < count; i++) {
    await writeFile(join(root, `${i}.jsonl`), [
      { type: 'session', id: `session-${i}`, timestamp: new Date(now - RETENTION_MS - 60_000).toISOString(), cwd: dir },
      { type: 'message', message: { role: 'user', content: `first prompt ${i}` } },
      { type: 'session_info', name: `named session ${i}` },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await utimes(join(root, `${i}.jsonl`), new Date(now - RETENTION_MS - 60_000), new Date(now - RETENTION_MS - 60_000));
  }
  const manifests = await store.trashFamilies((await store.scan({ now })).candidates, { now, guard: async () => true });
  t.after(async () => {
    gate.resolve();
    previewGate.resolve();
    finish?.(undefined);
    await hooks.session_shutdown({}, ctx);
    await rm(dir, { recursive: true, force: true });
  });
  return Object.assign(f, {
    dir, root, trash, store, manifests, hooks, commands, ctx, notifications, confirmations, reads, updates, removals, previewRequests, previewFrames,
    mounted: mounted.promise, entered: entered.promise, indexed: indexed.promise, previewEntered: previewEntered.promise, previewFailed: previewFailed.promise,
    finish: value => finish(value), release: () => gate.resolve(), releasePreview: () => previewGate.resolve(),
    press: key => component.handleInput(key),
  });
}

test('the picker mounts with filenames before transcript reads and enriches it progressively', async t => {
  const f = await fixture(t, { hold: true });
  const running = f.commands['session-trash'].handler('named', f.ctx);
  await f.mounted;
  assert.equal(f.reads.length, 0);
  assert.equal(f.updates[0].progress.completed, 0);
  assert.ok(f.updates[0].choices.every(choice => choice.label.endsWith('.jsonl')));
  await f.entered;
  f.release();
  await f.indexed;
  assert.ok(f.updates.at(-1).choices.every(choice => /named session/.test(choice.label)));
  assert.equal(f.updates.at(-1).progress.failed, 0);
  f.finish(undefined);
  await running;
  assert.deepEqual(f.notifications, []);
  assert.equal(f.confirmations.length, 0);
});

for (const action of ['cancel', 'select', 'shutdown']) {
  test(`${action} aborts enrichment and drains it before releasing either lock`, async t => {
    const f = await fixture(t, { hold: true });
    let complete = false;
    const running = f.commands['session-trash'].handler('', f.ctx).then(() => { complete = true; });
    await f.mounted;
    await f.entered;
    const updates = f.updates.length;
    let shutdown;
    if (action === 'shutdown') shutdown = f.hooks.session_shutdown({}, f.ctx);
    else f.finish(action === 'select' ? f.manifests[0].id : undefined);
    await Promise.resolve();
    assert.equal(complete, false);
    assert.equal(f.confirmations.length, 0);
    await access(join(f.trash, '.maintenance.lock'));
    await access(join(f.dir, 'registry', '.registry.lock'));
    f.release();
    await running;
    await shutdown;
    assert.equal(f.updates.length, updates);
    await assert.rejects(access(join(f.trash, '.maintenance.lock')), { code: 'ENOENT' });
    await assert.rejects(access(join(f.dir, 'registry', '.registry.lock')), { code: 'ENOENT' });
    if (action === 'select') {
      assert.equal(f.confirmations.length, 1);
      assert.ok(f.removals.includes(f.manifests[0].id));
      await access(join(f.root, f.manifests[0].files[0].original));
    } else assert.equal(f.confirmations.length, 0);
    assert.deepEqual(f.notifications.filter(n => n.level === 'error' || n.level === 'warning'), []);
  });
}

test('metadata failures keep filename fallback and do not disable an explicitly confirmed restore', async t => {
  const f = await fixture(t, { failure: true });
  const running = f.commands['session-trash'].handler('', f.ctx);
  await f.mounted;
  await f.indexed;
  const latest = f.updates.at(-1);
  assert.equal(latest.progress.failed, f.manifests.length);
  assert.ok(latest.choices.every(choice => choice.description.includes('search metadata unavailable')));
  f.finish(f.manifests[0].id);
  await running;
  await access(join(f.root, f.manifests[0].files[0].original));
  assert.equal(f.confirmations.length, 1);
});

test('restoring after enrichment still revalidates current files rather than trusting cached metadata', async t => {
  const f = await fixture(t);
  const running = f.commands['session-trash'].handler('', f.ctx);
  await f.mounted;
  await f.indexed;
  const manifest = f.manifests[0];
  const original = join(f.root, manifest.files[0].original);
  await writeFile(original, 'new file that must not be overwritten');
  f.finish(manifest.id);
  await running;
  assert.equal(await readFile(original, 'utf8'), 'new file that must not be overwritten');
  assert.ok(f.notifications.some(n => /Restore collision/.test(n.text)));
  await access(join(f.trash, manifest.id, '0.jsonl'));
});

test('expired-family purge discards advisory search cache without treating its directory as a Trash batch', async t => {
  const f = await fixture(t);
  const running = f.commands['session-trash'].handler('', f.ctx);
  await f.mounted;
  await f.indexed;
  f.finish(undefined);
  await running;
  assert.deepEqual((await f.store.listTrash()).issues, []);
  f.now += RETENTION_MS + 1;
  await f.commands['session-cleanup'].handler('', f.ctx);
  assert.deepEqual(f.removals.sort(), f.manifests.map(m => m.id).sort());
  assert.equal((await f.store.listTrash()).batches.length, 0);
  assert.deepEqual(f.notifications.filter(n => n.level === 'error' || n.level === 'warning'), []);
});

for (const approved of [false, true]) {
  test(`Ctrl+R from search requires confirmation (approved=${approved}) without loading a preview`, async t => {
    const f = await fixture(t, { realDialog: true, approved });
    const running = f.commands['session-trash'].handler('', f.ctx);
    await f.mounted;
    f.press('\x12');
    await running;
    assert.equal(f.previewRequests.length, 0);
    assert.equal(f.confirmations.length, 1);
    const remaining = (await f.store.listTrash()).batches.length;
    assert.equal(remaining, approved ? f.manifests.length - 1 : f.manifests.length);
  });
}

for (const action of ['restore', 'shutdown']) {
  test(`${action} drains preview and indexing before releasing locks or confirming`, async t => {
    const f = await fixture(t, { realDialog: true, hold: true, previewHold: true });
    let complete = false;
    const running = f.commands['session-trash'].handler('', f.ctx).then(() => { complete = true; });
    await f.mounted;
    f.press('\r');
    await f.previewEntered;
    await f.entered;
    assert.equal(f.confirmations.length, 0);
    const countBefore = (await f.store.listTrash()).batches.length;
    let shutdown;
    if (action === 'restore') f.press('\x12');
    else shutdown = f.hooks.session_shutdown({}, f.ctx);
    await setImmediate();
    assert.ok(f.previewRequests[0].signal.aborted);
    assert.equal(complete, false);
    assert.equal(f.confirmations.length, 0);
    f.release();
    await setImmediate();
    assert.equal(complete, false);
    assert.equal(f.confirmations.length, 0);
    await access(join(f.trash, '.maintenance.lock'));
    await access(join(f.dir, 'registry', '.registry.lock'));
    assert.equal((await f.store.listTrash()).batches.length, countBefore);
    f.releasePreview();
    await running;
    await shutdown;
    assert.equal(f.confirmations.length, action === 'restore' ? 1 : 0);
    assert.equal((await f.store.listTrash()).batches.length, action === 'restore' ? countBefore - 1 : countBefore);
    await assert.rejects(access(join(f.trash, '.maintenance.lock')), { code: 'ENOENT' });
    await assert.rejects(access(join(f.dir, 'registry', '.registry.lock')), { code: 'ENOENT' });
  });
}

test('a changed manifest is refused before preview and before restore confirmation', async t => {
  const f = await fixture(t, { realDialog: true });
  const running = f.commands['session-trash'].handler('', f.ctx);
  await f.mounted;
  for (const manifest of f.manifests) {
    await writeFile(join(f.trash, manifest.id, 'manifest.json'), JSON.stringify({ ...manifest, trashedAt: manifest.trashedAt + 1 }));
  }
  f.press('\r');
  await f.previewFailed;
  assert.ok(f.previewFrames.some(frame => /family changed/.test(frame)));
  // Back and quick restore also exercise the same current-manifest guard.
  f.press('\x1b');
  f.press('\x12');
  await running;
  assert.equal(f.previewRequests.length, 0);
  assert.equal(f.confirmations.length, 0);
  assert.ok(f.notifications.some(n => /family changed/.test(n.text)));
  assert.equal((await f.store.listTrash()).batches.length, f.manifests.length);
});

test('a manifest change during preview loading cannot publish the late excerpt', async t => {
  const f = await fixture(t, { realDialog: true, previewHold: true });
  const running = f.commands['session-trash'].handler('', f.ctx);
  await f.mounted;
  f.press('\r');
  await f.previewEntered;
  const manifest = f.previewRequests[0].batch.manifest;
  await writeFile(join(f.trash, manifest.id, 'manifest.json'), JSON.stringify({ ...manifest, trashedAt: manifest.trashedAt + 1 }));
  f.releasePreview();
  await f.previewFailed;
  assert.ok(f.previewFrames.some(frame => /family changed/.test(frame)));
  assert.ok(f.previewFrames.every(frame => !frame.includes('Preview first request')));
  f.press('\x12');
  await running;
  assert.equal(f.confirmations.length, 0);
  assert.equal((await f.store.listTrash()).batches.length, f.manifests.length);
});

test('cache-removal failure is reported without undoing a completed restore', async t => {
  const f = await fixture(t, { removeFailure: true });
  const running = f.commands['session-trash'].handler('', f.ctx);
  await f.mounted;
  await f.indexed;
  f.finish(f.manifests[0].id);
  await running;
  await access(join(f.root, f.manifests[0].files[0].original));
  assert.ok(f.notifications.some(n => /metadata could not be removed/.test(n.text)));
  assert.ok(f.notifications.some(n => /family restored/.test(n.text)));
});

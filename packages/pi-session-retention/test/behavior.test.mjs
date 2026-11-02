import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetentionStore, RETENTION_MS } from '../src/core.ts';
import { otherPiProcesses, maintenanceGuard } from '../src/safety.ts';

test('retention round trip protects current families, requires guard and restores without overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-retention-package-'));
  try {
    const root = join(dir, 'sessions'), trash = join(dir, 'trash');
    await mkdir(root);
    const file = join(root, 'old.jsonl'), now = Date.now(), old = now - RETENTION_MS - 60000;
    await writeFile(file, JSON.stringify({ type: 'session', id: 'old', timestamp: new Date(old).toISOString() }) + '\n');
    await utimes(file, new Date(old), new Date(old));
    const store = new RetentionStore(root, trash);
    assert.equal((await store.scan({ now, protectedPaths: [file] })).candidates.length, 0);
    const scan = await store.scan({ now });
    assert.equal(scan.candidates.length, 1);
    await assert.rejects(store.trashFamily(scan.candidates[0], { now, guard: async () => false }), /guard refused/);
    const manifest = await store.trashFamily(scan.candidates[0], { now, guard: async () => true });
    await assert.rejects(access(file), { code: 'ENOENT' });
    assert.equal((await store.listTrash()).batches.length, 1);
    await writeFile(file, 'collision');
    await assert.rejects(store.restoreFamily(manifest.id, { now, guard: async () => true }), /Restore collision/);
    await rm(file);
    await store.restoreFamily(manifest.id, { now, guard: async () => true });
    await access(file);
    assert.equal((await store.listTrash()).batches.length, 0);
    assert.equal((await store.scan({ now })).candidates.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('maintenance inventory fails closed and caches probes only within a second', async () => {
  assert.throws(() => otherPiProcesses([], 1), /Cannot verify/);
  assert.equal(otherPiProcesses([{ pid: 1, name: 'pi-bolt', command: '' }, { pid: 2, name: 'pi', command: '' }], 1).length, 1);
  let clock = 0, calls = 0;
  const guard = maintenanceGuard(async () => { calls++; }, () => clock);
  await guard(); await guard(); assert.equal(calls, 1);
  clock = 1000; await guard(); assert.equal(calls, 2);
});

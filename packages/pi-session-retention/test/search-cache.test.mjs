import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashSearchCache } from '../src/search-cache.ts';
import { loadExtension } from '../../../test/load-extension.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const signal = () => new AbortController().signal;
const transcript = (name = 'last') => [
  { type: 'session', id: 'session-id', cwd: '/work/project' },
  { type: 'session_info', name: 'old' },
  { type: 'message', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'first\u001b prompt' }] } },
  { type: 'message', message: { role: 'user', content: 'ignored second prompt' } },
  { type: 'session_info', name },
].map(JSON.stringify).join('\n') + '\n{broken\nnull\n';

async function fixture(t) {
  const dir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'pi-search-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'trash'), batchDir = join(root, id);
  await fs.mkdir(batchDir, { recursive: true });
  const path = join(batchDir, '0.jsonl');
  await fs.writeFile(path, transcript());
  const batch = { manifest: { version: 1, id, ready: true, trashedAt: 123, files: [{ original: 'project/session.jsonl', stored: '0.jsonl' }] }, missing: [] };
  const cachePath = join(root, '.search-cache', `${id}.json`);
  return { dir, root, path, batchDir, batch, cachePath, cache: new TrashSearchCache(root) };
}

function instrument(f, onStream) {
  let reads = 0;
  const { TrashSearchCache: Cache } = loadExtension(new URL('../src/search-cache.ts', import.meta.url), {
    'node:fs/promises': {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[0] !== f.path) return handle;
        reads++;
        return new Proxy(handle, { get(target, key) {
          if (key === 'createReadStream') return options => {
            const stream = handle.createReadStream(options);
            onStream?.(stream);
            return stream;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    },
  });
  return { cache: new Cache(f.root), reads: () => reads };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('native TS scan preserves last name, first user text, malformed lines and cleanText; warm hit opens no transcripts', async t => {
  const f = await fixture(t);
  const result = await f.cache.read(f.batch, signal());
  assert.deepEqual(result, { search: `${id} project/session.jsonl session-id /work/project last first prompt`, title: 'last', cwd: '/work/project' });
  const tracked = instrument(f);
  assert.deepEqual(plain(await tracked.cache.read(f.batch, signal())), result);
  assert.equal(tracked.reads(), 0);
  const saved = JSON.parse(await fs.readFile(f.cachePath, 'utf8'));
  assert.equal(saved.version, 2); // v2: records carry the cwd used for Trash folder labels.
  assert.equal(saved.fingerprint.length, 64);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.cachePath)).mode & 0o777, 0o600);
  await f.cache.remove(['../0', id]);
  await assert.rejects(fs.access(f.cachePath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.path, 'utf8'), transcript());
});

test('group cwd is captured, persisted and survives warm hits; legacy entries without it stay valid', async t => {
  const f = await fixture(t), tracked = instrument(f);
  await tracked.cache.read(f.batch, signal());
  const saved = JSON.parse(await fs.readFile(f.cachePath, 'utf8'));
  assert.equal(saved.cwd, '/work/project');
  delete saved.cwd; // A pre-grouping cache record without cwd remains a valid warm hit.
  await fs.writeFile(f.cachePath, JSON.stringify(saved));
  const warm = await tracked.cache.read(f.batch, signal());
  assert.equal(warm.cwd, undefined);
  assert.equal(warm.title, 'last');
  assert.equal(tracked.reads(), 1);
});

test('pre-grouping v1 cache records miss once and re-extract with cwd', async t => {
  const f = await fixture(t), tracked = instrument(f);
  await tracked.cache.read(f.batch, signal()); // Writes a v2 record.
  const saved = JSON.parse(await fs.readFile(f.cachePath, 'utf8'));
  await fs.writeFile(f.cachePath, JSON.stringify({ ...saved, version: 1 }));
  const result = await tracked.cache.read(f.batch, signal());
  assert.equal(result.cwd, '/work/project');
  assert.equal(tracked.reads(), 2);
});

test('cache erasure removes only selected records and their abandoned write files', async t => {
  const f = await fixture(t);
  await f.cache.read(f.batch, signal());
  const directory = join(f.root, '.search-cache');
  const abandoned = `${id}.32345678-1234-1234-1234-123456789abc.tmp`;
  const unrelated = '22345678-1234-1234-1234-123456789abc.json';
  await fs.writeFile(join(directory, abandoned), 'abandoned prompt text');
  await fs.writeFile(join(directory, unrelated), 'another family');
  await fs.writeFile(join(directory, 'unknown-file'), 'leave unknown entries alone');
  await f.cache.remove([id]);
  assert.deepEqual((await fs.readdir(directory)).sort(), [unrelated, 'unknown-file'].sort());
  assert.equal(await fs.readFile(f.path, 'utf8'), transcript());
});

test('ctime detects same-size edits with restored mtime; inode replacement invalidates warm entries', async t => {
  const f = await fixture(t), tracked = instrument(f);
  const fixed = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(f.path, fixed, fixed);
  await tracked.cache.read(f.batch, signal());
  const before = await fs.stat(f.path, { bigint: true });
  await fs.writeFile(f.path, transcript('next'));
  await fs.utimes(f.path, fixed, fixed);
  const after = await fs.stat(f.path, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.equal((await tracked.cache.read(f.batch, signal())).title, 'next');
  assert.equal(tracked.reads(), 2);
  const replacement = join(f.batchDir, 'replacement');
  await fs.writeFile(replacement, transcript('swap'));
  await fs.utimes(replacement, fixed, fixed);
  await fs.rename(replacement, f.path);
  assert.equal((await tracked.cache.read(f.batch, signal())).title, 'swap');
  assert.equal(tracked.reads(), 3);
});

test('missing high-resolution identity fields cannot validate a warm cache record', async t => {
  const f = await fixture(t);
  await f.cache.read(f.batch, signal());
  const { TrashSearchCache: Cache } = loadExtension(new URL('../src/search-cache.ts', import.meta.url), {
    'node:fs/promises': {
      ...fs,
      lstat: async (path, options) => {
        const value = await fs.lstat(path, options);
        if (path === f.path && options?.bigint) value.ctimeNs = undefined;
        return value;
      },
    },
  });
  await assert.rejects(new Cache(f.root).read(f.batch, signal()), /identity or timestamp precision/);
});

test('manifest membership, original paths, ready, time and missing state invalidate cache', async t => {
  const f = await fixture(t), tracked = instrument(f);
  await tracked.cache.read(f.batch, signal());
  for (const change of [
    b => { b.manifest.ready = false; },
    b => { b.manifest.trashedAt++; },
    b => { b.manifest.files[0].original = 'renamed.jsonl'; },
  ]) {
    const batch = structuredClone(f.batch);
    change(batch);
    const before = tracked.reads();
    await tracked.cache.read(batch, signal());
    assert.equal(tracked.reads(), before + 1);
  }
  await fs.writeFile(join(f.batchDir, '1.jsonl'), transcript('second'));
  f.batch.manifest.files.push({ original: 'second.jsonl', stored: '1.jsonl' });
  assert.equal((await tracked.cache.read(f.batch, signal())).title, 'last / second');
  await fs.unlink(f.path);
  await assert.rejects(tracked.cache.read(f.batch, signal()), /changed/);
  f.batch.missing.push('0.jsonl');
  assert.equal((await tracked.cache.read(f.batch, signal())).title, 'second');
  await fs.writeFile(f.path, transcript());
  await assert.rejects(tracked.cache.read(f.batch, signal()), /changed/);
});

test('corrupt, old, invalid-schema and oversized cache entries are misses', async t => {
  const f = await fixture(t), tracked = instrument(f);
  await tracked.cache.read(f.batch, signal());
  const valid = JSON.parse(await fs.readFile(f.cachePath, 'utf8'));
  for (const content of ['{', JSON.stringify({ ...valid, version: 0 }), JSON.stringify({ ...valid, title: 3 }), JSON.stringify({ ...valid, cwd: 7 }), JSON.stringify({ ...valid, cwd: 'bad\ncwd' }), JSON.stringify({ ...valid, fingerprint: 'wrong' }), ' '.repeat(8 * 1024 * 1024 + 1)]) {
    await fs.writeFile(f.cachePath, content);
    const before = tracked.reads();
    assert.equal((await tracked.cache.read(f.batch, signal())).title, 'last');
    assert.equal(tracked.reads(), before + 1);
  }
});

test('symlink cache leaves target untouched; unsafe transcript and standalone traversal rejected', async t => {
  const f = await fixture(t);
  await f.cache.read(f.batch, signal());
  const target = join(f.dir, 'outside.json');
  await fs.writeFile(target, await fs.readFile(f.cachePath));
  const original = await fs.readFile(target, 'utf8');
  await fs.unlink(f.cachePath);
  try { await fs.symlink(target, f.cachePath); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; } throw error; }
  const tracked = instrument(f);
  assert.equal((await tracked.cache.read(f.batch, signal())).title, 'last');
  assert.equal(tracked.reads(), 1);
  await assert.rejects(tracked.cache.remove([id]), /Unsafe/);
  assert.equal((await fs.lstat(f.cachePath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), original);
  await fs.unlink(f.path);
  await fs.symlink(target, f.path);
  await assert.rejects(f.cache.read(f.batch, signal()), /Unsafe|regular/);
  for (const value of ['../outside', '/absolute', 'C:\\outside']) {
    const batch = structuredClone(f.batch);
    batch.manifest.id = value;
    await assert.rejects(f.cache.read(batch, signal()), /Invalid/);
    batch.manifest.id = id;
    batch.manifest.files[0].stored = value;
    await assert.rejects(f.cache.read(batch, signal()), /Invalid/);
  }
});

test('unusable cache directory does not block metadata and does not touch transcripts', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.root, '.search-cache'), 'not a directory');
  assert.equal((await f.cache.read(f.batch, signal())).title, 'last');
  assert.equal(await fs.readFile(f.path, 'utf8'), transcript());
});

test('oversized search text remains complete but is not persisted', async t => {
  const f = await fixture(t);
  const prompt = 'x'.repeat(8 * 1024 * 1024 + 1);
  await fs.writeFile(f.path, JSON.stringify({ type: 'message', message: { role: 'user', content: prompt } }) + '\n');
  const result = await f.cache.read(f.batch, signal());
  assert.equal(result.title, prompt);
  assert.equal(result.search, `${id} project/session.jsonl ${prompt}`);
  await assert.rejects(fs.access(f.cachePath), { code: 'ENOENT' });
});

test('symlink cache ancestors are never read or written', async t => {
  const f = await fixture(t);
  await f.cache.read(f.batch, signal());
  const outside = join(f.dir, 'outside');
  await fs.rename(join(f.root, '.search-cache'), outside);
  const saved = await fs.readFile(join(outside, `${id}.json`), 'utf8');
  await fs.symlink(outside, join(f.root, '.search-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  const tracked = instrument(f);
  assert.equal((await tracked.cache.read(f.batch, signal())).title, 'last');
  assert.equal(tracked.reads(), 1);
  await assert.rejects(tracked.cache.remove([id]), /Unsafe/);
  assert.equal(await fs.readFile(join(outside, `${id}.json`), 'utf8'), saved);
});

test('stream I/O errors reject rather than publishing partial metadata', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const tracked = instrument(f, stream => stream.prependOnceListener('data', () => stream.destroy(new Error('fixture read failure'))));
  await assert.rejects(tracked.cache.read(f.batch, signal()), /fixture read failure/);
  await assert.rejects(fs.access(f.cachePath), { code: 'ENOENT' });
});

test('a transcript change during a warm cache lookup rejects stale text before display', async t => {
  const f = await fixture(t);
  await f.cache.read(f.batch, signal());
  let mutated = false;
  const { TrashSearchCache: Cache } = loadExtension(new URL('../src/search-cache.ts', import.meta.url), {
    'node:fs/promises': {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[0] !== f.cachePath) return handle;
        return new Proxy(handle, { get(target, key) {
          if (key === 'read') return async (...readArgs) => {
            if (!mutated) { mutated = true; writeFileSync(f.path, transcript('edit')); }
            return handle.read(...readArgs);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    },
  });
  await assert.rejects(new Cache(f.root).read(f.batch, signal()), /changed/);
  assert.equal((await f.cache.read(f.batch, signal())).title, 'edit');
});

test('mutation during streaming rejects metadata and publishes no cache', async t => {
  const f = await fixture(t);
  const tracked = instrument(f, stream => stream.prependOnceListener('data', () => writeFileSync(f.path, transcript('edit'))));
  await assert.rejects(tracked.cache.read(f.batch, signal()), /changed/);
  await assert.rejects(fs.access(f.cachePath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.path, 'utf8'), transcript('edit'));
});

test('abort during streaming drains handles, publishes no partial cache, retains completed batches', async t => {
  const f = await fixture(t);
  await f.cache.read(f.batch, signal());
  const completed = await fs.readFile(f.cachePath, 'utf8');
  const secondId = '22345678-1234-1234-1234-123456789abc';
  await fs.mkdir(join(f.root, secondId));
  const secondPath = join(f.root, secondId, '0.jsonl');
  await fs.writeFile(secondPath, transcript() + ' '.repeat(256 * 1024));
  const controller = new AbortController();
  const tracked = instrument({ ...f, path: secondPath }, stream => stream.prependOnceListener('data', () => controller.abort()));
  const batch = structuredClone(f.batch);
  batch.manifest.id = secondId;
  await assert.rejects(tracked.cache.read(batch, controller.signal), /abort/i);
  await assert.rejects(fs.access(join(f.root, '.search-cache', `${secondId}.json`)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.cachePath, 'utf8'), completed);
  assert.deepEqual((await fs.readdir(join(f.root, '.search-cache'))), [`${id}.json`]);
  await fs.rename(secondPath, `${secondPath}.closed`);
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(f.cache.read(f.batch, preAborted.signal), /abort/i);
});

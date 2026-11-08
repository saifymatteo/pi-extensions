import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTrashPreview } from '../src/preview.ts';
import { loadExtension } from '../../../test/load-extension.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const signal = () => new AbortController().signal;
const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content } });
async function fixture(t, entries = []) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'pi-trash-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = join(root, id), path = join(dir, '0.jsonl');
  await fs.mkdir(dir);
  const text = [{ type: 'session', version: 3, cwd: '/fixture/project' }, ...entries].map(JSON.stringify).join('\n') + '\n{malformed\nnull\n';
  await fs.writeFile(path, text);
  const batch = { manifest: { version: 1, id, ready: true, trashedAt: 1, files: [{ original: 'session.jsonl', stored: '0.jsonl' }] }, missing: [] };
  return { root, dir, path, batch, text, read: () => loadTrashPreview(root, batch, 0, signal()) };
}
function instrument(f, onStream) {
  let opens = 0;
  const { loadTrashPreview: read } = loadExtension(new URL('../src/preview.ts', import.meta.url), {
    'node:fs/promises': { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      if (args[0] !== f.path) return handle;
      opens++;
      return new Proxy(handle, { get(target, key) {
        if (key === 'createReadStream') return options => { const stream = handle.createReadStream(options); onStream(stream, opens); return stream; };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } },
  });
  return (signalValue = signal()) => read(f.root, f.batch, 0, signalValue);
}

test('preview follows current ancestry, ignores abandoned branches/tools/thinking, and cleans terminal controls', async t => {
  const f = await fixture(t, [
    message('root', null, 'user', 'First request'),
    message('old', 'root', 'assistant', 'Abandoned response'),
    message('new', 'root', 'assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: '\x1b[31mUseful\x1b[0m\nanswer\x00' }]),
    message('tool', 'new', 'toolResult', 'Tool output must stay hidden'),
    message('last', 'tool', 'user', [{ type: 'image', data: 'not text' }, { type: 'text', text: 'Next question' }]),
    { type: 'session_info', id: 'name', parentId: 'last', name: 'Final name' },
  ]);
  const value = await f.read();
  assert.equal(value.name, 'Final name');
  assert.equal(value.cwd, '/fixture/project');
  assert.equal(value.firstRequest, 'First request');
  assert.deepEqual(value.recent.map(m => m.text), ['First request', 'Useful\nanswer', 'Next question']);
  assert.doesNotMatch(JSON.stringify(value), /Abandoned|private reasoning|Tool output|not text|\\u001b/);
  assert.equal(await fs.readFile(f.path, 'utf8'), f.text);
  assert.deepEqual(await fs.readdir(f.root), [id]);
});

test('legacy linear sessions remain readable without rewriting or migrating them', async t => {
  const f = await fixture(t);
  const text = [{ type: 'session', version: 1, cwd: '/legacy' }, { type: 'message', message: { role: 'user', content: 'Legacy request' } }].map(JSON.stringify).join('\n');
  await fs.writeFile(f.path, text);
  assert.equal((await f.read()).firstRequest, 'Legacy request');
  assert.equal(await fs.readFile(f.path, 'utf8'), text);
});

test('excerpts are bounded to six recent messages and four thousand characters', async t => {
  const entries = Array.from({ length: 12 }, (_, i) => message(`m${i}`, i ? `m${i - 1}` : null, i % 2 ? 'assistant' : 'user', `${i}:` + 'x'.repeat(6000)));
  const f = await fixture(t, entries), value = await f.read();
  assert.equal(value.recent.length, 6);
  assert.ok(value.recent.every(m => m.text.length <= 4000));
  assert.equal(value.firstRequest.length, 4000);
  assert.equal(value.truncated, true);
  assert.ok(value.recent[0].text.startsWith('6:'));
});

test('multi-part text shortened at an exact boundary is marked as truncated', async t => {
  const f = await fixture(t, [message('a', null, 'user', [{ type: 'text', text: 'x'.repeat(4000) }, { type: 'text', text: 'omitted' }])]);
  const value = await f.read();
  assert.equal(value.firstRequest.length, 4000);
  assert.equal(value.truncated, true);
});

test('oversized tree metadata and transcript entries fail with explicit preview limits', async t => {
  const f = await fixture(t);
  const entries = Array.from({ length: 4100 }, (_, i) => ({ type: 'custom', id: String(i).padStart(256, 'x'), parentId: i ? String(i - 1).padStart(256, 'x') : null }));
  await fs.writeFile(f.path, entries.map(JSON.stringify).join('\n'));
  await assert.rejects(f.read(), /tree exceeds the preview limit/);
  await fs.writeFile(f.path, JSON.stringify({ type: 'custom', data: 'x'.repeat(16 * 1024 * 1024) }));
  await assert.rejects(f.read(), /entry exceeds 16 MiB/);
});

test('multiple roots use only the last root and malformed tree structure fails closed', async t => {
  const f = await fixture(t, [message('old', null, 'user', 'old root'), message('new', null, 'user', 'new root')]);
  assert.equal((await f.read()).firstRequest, 'new root');
  for (const entries of [
    [message('a', 'missing', 'user', 'orphan')],
    [message('a', 'b', 'user', 'cycle'), message('b', 'a', 'assistant', 'cycle')],
    [message('a', null, 'user', 'first'), message('a', null, 'user', 'duplicate')],
    [message('a', null, 'user', 'tree'), { type: 'message', message: { role: 'user', content: 'idless' } }],
  ]) {
    await fs.writeFile(f.path, entries.map(JSON.stringify).join('\n'));
    await assert.rejects(f.read(), /Cannot verify/);
  }
});

test('invalid IDs, stored/original traversal, missing members and invalid indices are refused', async t => {
  const f = await fixture(t, [message('a', null, 'user', 'safe')]);
  for (const index of [-1, 0.5, 1, NaN]) await assert.rejects(loadTrashPreview(f.root, f.batch, index, signal()), /Invalid/);
  for (const change of [
    b => { b.manifest.id = '../outside'; },
    b => { b.manifest.files[0].stored = '../outside.jsonl'; },
    b => { b.manifest.files[0].original = '../outside.jsonl'; },
    b => { b.manifest.files[0].original = 'C:\\outside.jsonl'; },
  ]) {
    const batch = structuredClone(f.batch); change(batch);
    await assert.rejects(loadTrashPreview(f.root, batch, 0, signal()), /Invalid/);
  }
  f.batch.missing.push('0.jsonl');
  await assert.rejects(f.read(), /missing/);
});

test('symlinked sources are refused without reading or changing their targets', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'outside.jsonl');
  await fs.writeFile(target, 'private target'); await fs.unlink(f.path);
  try { await fs.symlink(target, f.path); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; } throw error; }
  await assert.rejects(f.read(), /Unsafe/);
  assert.equal(await fs.readFile(target, 'utf8'), 'private target');
});

for (const pass of [1, 2]) test(`mutation during preview pass ${pass} rejects excerpts`, async t => {
  const f = await fixture(t, [message('a', null, 'user', 'original')]);
  const read = instrument(f, (stream, number) => { if (number === pass) stream.prependOnceListener('data', () => writeFileSync(f.path, f.text + '\n')); });
  await assert.rejects(read(), /changed/);
});

test('abort and I/O errors drain streams and close handles rather than publishing partial text', async t => {
  const f = await fixture(t, [message('a', null, 'user', 'request')]);
  const controller = new AbortController();
  const aborting = instrument(f, stream => stream.prependOnceListener('data', () => controller.abort()));
  await assert.rejects(aborting(controller.signal), /abort/i);
  const failing = instrument(f, stream => stream.prependOnceListener('data', () => stream.destroy(new Error('fixture I/O error'))));
  await assert.rejects(failing(), /fixture I\/O error/);
  await fs.rename(f.path, `${f.path}.closed`);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(loadTrashPreview(f.root, f.batch, 0, alreadyAborted.signal), /abort/i);
});

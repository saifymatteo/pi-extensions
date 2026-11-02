import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadExtension } from '../../../test/load-extension.mjs';
const { buildSessionRows } = loadExtension(new URL('../src/index.ts', import.meta.url), {
  '@earendil-works/pi-coding-agent': {}, '@earendil-works/pi-tui': {},
});
test('child search retains ancestors and family activity controls project ordering', () => {
  const root = { id: 'root', path: resolve('fixtures/root.jsonl'), cwd: '/project-a', name: 'parent', firstMessage: '', modified: 1 };
  const child = { id: 'child', path: resolve('fixtures/child.jsonl'), cwd: '/project-a', parentSession: root.path, name: 'needle', firstMessage: '', modified: 100 };
  const other = { id: 'other', path: resolve('fixtures/other.jsonl'), cwd: '/project-b', firstMessage: 'other', modified: 50 };
  const all = buildSessionRows([root, other, child], '');
  assert.equal(all[0].label, '/project-a');
  const filtered = buildSessionRows([root, other, child], 'NEEDLE');
  assert.deepEqual(Array.from(filtered.filter(x => x.kind === 'session'), x => x.session.id), ['root', 'child']);
  assert.match(filtered[2].treePrefix, /└─/);
  assert.equal(buildSessionRows([root, child], 'missing').length, 0);
});

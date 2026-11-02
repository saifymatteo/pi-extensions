import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';
const { activeContextIds, buildNavigationItems, visibleRange } = loadExtension(new URL('../src/index.ts', import.meta.url), {
  '@earendil-works/pi-tui': {},
});
const message = (id, role, content) => ({ id, type: 'message', message: { role, content, timestamp: 42 } });

test('latest compaction keeps its retained prefix and subsequent branch only', () => {
  const branch = [message('old', 'user', 'old'), message('kept', 'user', 'kept'),
    { id: 'c1', type: 'compaction', firstKeptEntryId: 'kept' }, message('new', 'assistant', 'new')];
  assert.deepEqual([...activeContextIds(branch)], ['c1', 'kept', 'new']);
  const latest = [...branch, { id: 'c2', type: 'compaction', firstKeptEntryId: 'new' }, message('last', 'user', 'last')];
  assert.deepEqual([...activeContextIds(latest)], ['c2', 'new', 'last']);
  assert.deepEqual([...activeContextIds([{ id: 'c', type: 'compaction', firstKeptEntryId: 'missing' }, latest.at(-1)])], ['c', 'last']);
  assert.deepEqual([...activeContextIds(branch.slice(0, 2))], ['old', 'kept']);
});

test('navigation excludes inactive, tool, metadata, and textless messages; cleans previews', () => {
  const branch = [message('hidden', 'user', 'hidden'), message('user', 'user', [{ type: 'text', text: '  hello\n world\x1b ' }, { type: 'image' }]),
    message('tool', 'toolResult', 'result'), message('silent', 'assistant', [{ type: 'toolCall', name: 'read' }]),
    message('assistant', 'assistant', 'reply'), { id: 'custom', type: 'custom' }];
  const items = JSON.parse(JSON.stringify(buildNavigationItems(branch, new Set(branch.slice(1).map(x => x.id)))));
  assert.deepEqual(items, [
    { id: 'user', role: 'user', preview: 'hello world [image]', timestamp: 42, available: true },
    { id: 'assistant', role: 'assistant', preview: 'reply', timestamp: 42, available: true },
  ]);
});

test('visible window offset clamps at both edges including short and empty lists', () => {
  assert.equal(visibleRange(0, 20, 5), 0);
  assert.equal(visibleRange(7, 20, 5), 3);
  assert.equal(visibleRange(50, 20, 5), 15);
  assert.equal(visibleRange(2, 3, 10), 0);
  assert.equal(visibleRange(0, 0, 10), 0);
});

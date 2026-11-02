import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';
const { summarizeToolUsage } = loadExtension(new URL('../src/index.ts', import.meta.url), {
  '@earendil-works/pi-coding-agent': {}, '@earendil-works/pi-tui': {},
});
test('tool report groups MCP tools, counts nested/errors and preserves unused registration', () => {
  const row = { version: 1, timestamp: '2026-01-01T00:00:00.000+00:00', session: 's', cwd: '/fixture',
    tool: 'mcp__server__first', callId: '1', model: 'p/m', thinking: 'low', status: 'success', durationMs: 5 };
  const log = [row, { ...row, tool: 'mcp__server__second', callId: '2', parentCallId: '1', status: 'interrupted', durationMs: 10 },
    { ...row, durationMs: -1 }].map(x => JSON.stringify(x)).join('\n') + '\nbad';
  const summary = summarizeToolUsage(log, ['read', 'mcp__server__third']);
  assert.equal(summary.skipped, 2);
  const group = summary.tools[0];
  assert.equal(group.tool, 'mcp__server__*');
  assert.equal(group.calls, 2);
  assert.equal(group.sessions, 1);
  assert.equal(group.errors, 1);
  assert.equal(group.nested, 1);
  assert.equal(group.durationMs, 15);
  assert.equal(summary.tools[1].lastUsed, null);
});

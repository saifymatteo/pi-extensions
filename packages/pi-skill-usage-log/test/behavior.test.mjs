import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';
const { buildTracker, summarizeUsage } = loadExtension(new URL('../src/index.ts', import.meta.url), {
  '@earendil-works/pi-coding-agent': {}, '@earendil-works/pi-tui': {},
});
test('skill use requires follow-up activity in the request and is deduped per session', () => {
  const events = [], tracker = buildTracker(e => events.push(e));
  tracker.handleRequestStart();
  tracker.handleSkillRead('C:\\skills\\example\\SKILL.md');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'skill:load');
  assert.equal(tracker.handleTurnEnd().length, 0);
  tracker.handleToolCall('think');
  assert.equal(tracker.handleTurnEnd().length, 0);
  tracker.handleToolCall('read', { model: 'p/m', thinking: 'low' });
  assert.equal(tracker.handleTurnEnd()[0].event, 'skill:complete');
  assert.equal(tracker.handleTurnEnd().length, 0);
  tracker.handleRequestStart();
  tracker.handleSkillRead('/skills/example/SKILL.md');
  tracker.handleToolCall('bash');
  assert.equal(tracker.handleTurnEnd().length, 0);
  assert.equal(events.length, 2);
});
test('skill summary dedupes sessions, rejects malformed rows and includes unused skills', () => {
  const row = '2026-01-01T00:00:00.000Z\tsid\tcwd\tskill:complete\texample\t/path';
  const removed = '2026-01-01T00:00:00.000Z\tsid\tcwd\tskill:complete\tremoved\t/path';
  const summary = summarizeUsage(row + '\n' + row + '\n' + removed + '\nbad', ['example', 'unused']);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.skills.length, 2, 'removed skills are filtered out');
  assert.equal(summary.skills[0].uses, 1);
  assert.equal(summary.skills[1].skill, 'unused');
  assert.equal(summary.skills[1].lastUsed, null);
});

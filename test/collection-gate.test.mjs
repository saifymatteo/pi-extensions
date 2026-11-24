import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadExtension } from './load-extension.mjs';

const { gate } = loadExtension(new URL('../collection/gate.ts', import.meta.url));

function withConfig(text, run) {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-collection-gate-'));
  if (text !== undefined) {
    mkdirSync(join(agentDir, 'extensions'));
    writeFileSync(join(agentDir, 'extensions', 'pi-extensions.json'), text);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { run(); } finally { previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous; }
}

function loaded(name) {
  let calls = 0;
  gate(name, pi => { calls++; assert.equal(pi, 'pi'); })('pi');
  return calls === 1;
}

test('disabled packages skip registration; others load', () => withConfig('{"disabled":["pi-tts"]}', () => {
  assert.equal(loaded('pi-tts'), false);
  assert.equal(loaded('pi-zvec'), true);
}));

test('missing or invalid config loads everything', () => {
  withConfig(undefined, () => assert.equal(loaded('pi-tts'), true));
  withConfig('{ not json', () => assert.equal(loaded('pi-tts'), true));
});

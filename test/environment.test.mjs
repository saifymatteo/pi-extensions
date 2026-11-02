import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from '../scripts/environment.mjs';

test('isolated environment overrides inherited live session and temp locations', () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-env-test-'));
  try {
    const inherited = { PATH: 'keep-path', PI_CODING_AGENT_DIR: 'live-agent', PI_CODING_AGENT_SESSION_DIR: 'live-sessions', HERDR_ENV: '1', TMPDIR: 'live-temp', TMP: 'live-temp', TEMP: 'live-temp' };
    const env = isolatedEnvironment(home, inherited);
    assert.equal(env.PI_CODING_AGENT_DIR, home);
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, join(home, 'sessions'));
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(env[key], join(home, 'temp'));
    assert.ok(existsSync(env.TEMP));
    assert.ok(existsSync(env.PI_CODING_AGENT_SESSION_DIR));
    assert.equal(env.PATH, inherited.PATH);
    assert.equal(env.PI_OFFLINE, '1');
    assert.equal(env.HERDR_ENV, '1'); // passed through untouched: no Herdr special-casing
    assert.equal(inherited.TEMP, 'live-temp');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

import { mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Locate a runnable Pi host executable. PATH lookup alone goes stale when a
 * host update renames its binary, so fall back to the Pi-Bolt install layout
 * (`~/.pi-bolt/<version>/pi.exe`). Pi-Bolt is optional: any compatible `pi`
 * works. Returns the command plus the `--version` banner already probed from
 * it.
 */
export function resolveHost(env = process.env) {
  const candidates = [];
  if (env.PI_HOST) candidates.push(env.PI_HOST);
  else {
    candidates.push('pi', 'pi.exe', 'pi-bolt', 'pi-bolt.exe');
    try {
      for (const entry of readdirSync(join(homedir(), '.pi-bolt'))) {
        if (!entry.endsWith('.previous')) candidates.push(join(homedir(), '.pi-bolt', entry, 'pi.exe'));
      }
    } catch { /* no local Pi-Bolt install */ }
  }
  for (const command of candidates) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (!probe.error && probe.status === 0) return { command, version: probe.stdout.trim() };
  }
  throw new Error(`No runnable Pi host found (tried: ${candidates.join(', ')}). Set PI_HOST to the host executable.`);
}

/** Keep inherited session/temp overrides from pointing isolated runs at live stores. */
export function isolatedEnvironment(home, inherited = process.env) {
  const temporary = join(home, 'temp');
  const sessions = join(home, 'sessions');
  mkdirSync(temporary, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  return {
    ...inherited,
    PI_CODING_AGENT_DIR: home,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_OFFLINE: '1',
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
}

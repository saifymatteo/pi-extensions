import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isolatedEnvironment, resolveHost } from './environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { extensions } = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8'));
const selected = process.argv[2] || 'pi-session-id';
if (!extensions.some(e => e.directory === selected)) {
  console.error(`Unknown package: ${selected}. Choose a directory listed in inventory.json.`);
  process.exitCode = 1;
} else {
  let host;
  try { host = resolveHost(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  if (host) {
  mkdirSync(join(root, '.dev'), { recursive: true });
  const home = mkdtempSync(join(root, '.dev', 'agent-'));
  console.log(`Isolated agent home: ${home}\nLoading only ${selected}. Existing shell environment is inherited.\nNo credentials/configs copied; no packages installed. Session state is retained here for inspection.\nClose Pi with its normal exit shortcut. Delete this agent-* directory when finished.`);
  const child = spawn(host.command, [
    '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-mcp', '--no-context-files', '--no-session', '--no-approve',
    '-e', join(root, 'packages', selected),
  ], { cwd: home, env: isolatedEnvironment(home), stdio: 'inherit' });
  child.on('error', error => { console.error(`Could not launch host: ${error.message}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}

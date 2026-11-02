import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment, resolveHost } from './environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'pi-extension-smoke-'));
const { extensions } = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8'));
let failures = 0;
try {
  const { command: host, version } = resolveHost();
  console.log(version);
  const probe = join(home, 'probe.ts');
  writeFileSync(probe, 'export default function(pi) { pi.registerFlag("dev-load-probe", { description: "Confirms factory execution", type: "boolean", default: false }); }');
  for (const { directory } of extensions) {
    const result = spawnSync(host, [
      '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-mcp', '--no-context-files', '--no-session', '--no-approve',
      '-e', probe, '-e', join(root, 'packages', directory), '--help',
    ], { cwd: home, env: isolatedEnvironment(home), encoding: 'utf8', timeout: 30_000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.error || result.status !== 0 || !output.includes('--dev-load-probe') || /failed to load|error loading|extension errors|cannot find module|failed to resolve|syntaxerror|typeerror:/i.test(output)) {
      failures++;
      console.error(`FAIL ${directory}: ${result.error?.message || output}`);
    } else console.log(`PASS ${directory}: isolated help/startup`);
  }
} finally { rmSync(home, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
else console.log('No model calls, session lifecycle, interactive UI, clipboard, external CLI, or backend behavior was exercised.');

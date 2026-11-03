// Publishes every workspace package (inventory order), then the root collection tarball.
// Usage: node scripts/publish-all.mjs [--interactive] [-- --otp=NNNNNN]
// Extra args after `--` are forwarded to every `npm publish` (e.g. --otp=NNNNNN).
// --interactive: hand npm the terminal so its own web-auth/OIDC flow (browser 2FA
// authorization) can run per publish; results are tracked by exit code only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const extra = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
const interactive = args.includes('--interactive');

const npm = (cmdArgs, opts = {}) =>
  spawnSync('npm', cmdArgs, { cwd: root, encoding: 'utf8', shell: true, ...opts });

// Preflight: fail before touching anything if there is no session.
const whoami = npm(['whoami']);
if (whoami.status !== 0) {
  console.error('Not logged in to npm (whoami failed). Run `npm login` first, then re-run.');
  process.exit(1);
}
console.log(`npm: logged in as ${whoami.stdout.trim()}`);

const inventory = JSON.parse(readFileSync(resolve(root, 'inventory.json'), 'utf8'));
const targets = [
  ...inventory.extensions.map(e => ({
    name: `@saifymatteo/${e.directory}`,
    cwd: resolve(root, 'packages', e.directory),
  })),
  { name: '@saifymatteo/pi-extensions', cwd: root }, // root = all-in-one collection, last
];

const published = [];
const skipped = [];
const failed = [];

for (const { name, cwd } of targets) {
  console.log(`publish ${name} ...`);
  const result = interactive
    ? npm(['publish', ...extra], { cwd, stdio: 'inherit' })
    : npm(['publish', '--json', ...extra], { cwd });
  if (result.status === 0) {
    published.push(name);
    console.log(`-> OK ${name}`);
  } else {
    if (!interactive) {
      const out = `${result.stdout}\n${result.stderr}`;
      if (/previously published|EPUBLISHCONFLICT/i.test(out)) {
        console.log(`-> SKIP ${name} (already published)`);
        skipped.push(name);
        continue;
      }
      if (/EOTP|one-time password/i.test(out)) {
        console.error(`-> FAIL ${name}: web-auth required; re-run with --interactive`);
        break;
      }
      console.error(out.trim());
    }
    failed.push(name);
    console.error(`-> FAIL ${name} (exit ${result.status})`);
  }
}

console.log(`\nSummary: ${published.length} published, ${skipped.length} skipped, ${failed.length} failed`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}

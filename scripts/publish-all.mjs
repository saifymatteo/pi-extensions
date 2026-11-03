// Publishes every workspace package (inventory order), then the root collection tarball.
// Usage: node scripts/publish-all.mjs [-- --otp=NNNNNN]
// Extra args after `--` are forwarded to every `npm publish` (e.g. --otp=NNNNNN).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const extra = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];

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
  process.stdout.write(`publish ${name} ... `);
  const result = npm(['publish', '--json', ...extra], { cwd });
  const out = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    const data = JSON.parse(result.stdout);
    console.log(`OK ${data.version ?? ''} (${data.filename ?? ''})`);
    published.push(name);
  } else if (/previously published|EPUBLISHCONFLICT/i.test(out)) {
    console.log('SKIP already published');
    skipped.push(name);
  } else if (/EOTP|one-time password/i.test(out)) {
    console.log('FAIL needs OTP');
    failed.push(name);
    console.error('OTP required. Re-run with: node scripts/publish-all.mjs -- --otp=NNNNNN');
    break;
  } else {
    console.log('FAIL');
    failed.push(name);
    console.error(out.trim());
    break;
  }
}

console.log(`\nSummary: ${published.length} published, ${skipped.length} skipped, ${failed.length} failed`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}

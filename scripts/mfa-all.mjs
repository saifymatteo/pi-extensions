// Sets "Publishing access" to the recommended mode on every package:
// "Require two-factor authentication and disallow bypass-2FA tokens".
// Token-based publishing becomes impossible for these packages; trusted
// publishing (OIDC) keeps working — see docs.npmjs.com, package settings.
//
// Usage:
//   node scripts/mfa-all.mjs --interactive   # run in YOUR terminal: first call
//                                            # opens the browser for 2FA; tick
//                                            # "skip 2FA for the next 5 minutes"
//                                            # and the rest run unattended
//   node scripts/mfa-all.mjs                 # non-interactive (only works while
//                                            # the 5-minute 2FA skip is active)
//
// There is no CLI read-back for this setting; verify in npmjs.com package
// settings -> Publishing access after the run.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const interactive = process.argv.includes('--interactive');

const npm = (cmdArgs, opts = {}) =>
  spawnSync('npm', cmdArgs, { cwd: root, encoding: 'utf8', shell: true, ...opts });

const whoami = npm(['whoami']);
if (whoami.status !== 0) {
  console.error('Not logged in to npm (whoami failed). Run `npm login` first, then re-run.');
  process.exit(1);
}
console.log(`npm: logged in as ${whoami.stdout.trim()}`);

const inventory = JSON.parse(readFileSync(resolve(root, 'inventory.json'), 'utf8'));
const names = [
  ...inventory.extensions.map(e => `@saifymatteo/${e.directory}`),
  '@saifymatteo/pi-extensions', // root collection package too
];

const updated = [];
const failed = [];

for (const name of names) {
  console.log(`mfa ${name} ...`);
  const result = npm(['access', 'set', 'mfa=publish', name], interactive ? { stdio: 'inherit' } : {});
  if (result.status === 0) {
    updated.push(name);
  } else if (interactive) {
    failed.push(name);
    console.error(`-> FAIL ${name} (exit ${result.status})`);
  } else {
    const out = `${result.stdout}\n${result.stderr}`;
    if (/EOTP|one-time password/i.test(out)) {
      console.error(`-> FAIL ${name}: 2FA authorization required`);
      console.error('Run `node scripts/mfa-all.mjs --interactive` in your own terminal,');
      console.error('authorize in the browser, and tick "skip 2FA for the next 5 minutes".');
      failed.push(name);
      break;
    }
    console.error(out.trim());
    failed.push(name);
    break;
  }
  await new Promise(r => setTimeout(r, 2000)); // rate-limit spacing
}

console.log(`\nSummary: ${updated.length} updated, ${failed.length} failed`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}

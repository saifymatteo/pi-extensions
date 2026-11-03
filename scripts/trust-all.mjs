// Configures npm trusted publishing (OIDC) for every package, pointing each at
// this repo's .github/workflows/publish.yml so tag pushes publish without tokens.
//
// Usage:
//   node scripts/trust-all.mjs --interactive   # run in YOUR terminal: first call
//                                              # opens the browser for 2FA; tick
//                                              # "skip 2FA for the next 5 minutes"
//                                              # and the rest run unattended
//   node scripts/trust-all.mjs                 # non-interactive (only works while
//                                              # the 5-minute 2FA skip is active)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'saifymatteo/pi-extensions'; // must match package.json repository.url
const workflowFile = 'publish.yml';

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
  '@saifymatteo/pi-extensions', // root collection is published by tags too
];

const configured = [];
const skipped = [];
const failed = [];

for (const name of names) {
  console.log(`trust ${name} ...`);
  const result = npm(
    ['trust', 'github', name, '--repo', repo, '--file', workflowFile, '--allow-publish', '--yes'],
    interactive ? { stdio: 'inherit' } : {},
  );
  if (result.status === 0) {
    configured.push(name);
  } else if (interactive) {
    failed.push(name);
    console.error(`-> FAIL ${name} (exit ${result.status})`);
  } else {
    const out = `${result.stdout}\n${result.stderr}`;
    if (/already|ECONFLICT|409/i.test(out)) {
      console.log(`-> SKIP ${name} (trust config already exists)`);
      skipped.push(name);
    } else if (/EOTP|one-time password/i.test(out)) {
      console.error(`-> FAIL ${name}: 2FA authorization required`);
      console.error('Run `node scripts/trust-all.mjs --interactive` in your own terminal,');
      console.error('authorize in the browser, and tick "skip 2FA for the next 5 minutes".');
      failed.push(name);
      break;
    } else {
      console.error(out.trim());
      failed.push(name);
      break;
    }
  }
  await new Promise(r => setTimeout(r, 2000)); // rate-limit spacing (docs recommendation)
}

console.log(`\nSummary: ${configured.length} configured, ${skipped.length} skipped, ${failed.length} failed`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.npm_execpath, 'Run this check with npm run pack:check');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--workspaces', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
});
if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
const parsed = JSON.parse(result.stdout);
const packages = Array.isArray(parsed) ? parsed : Object.values(parsed);
const inventory = JSON.parse(readFileSync(resolve(root, 'inventory.json'), 'utf8'));
assert.deepEqual(packages.map(pkg => pkg.name).sort(), inventory.extensions.map(e => `@saifymatteo/${e.directory}`).sort());

// The root is the all-in-one collection tarball: it must bundle every package.
const rootPack = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
});
if (rootPack.error || rootPack.status !== 0) throw new Error(rootPack.error?.message || rootPack.stderr);
const rootParsed = JSON.parse(rootPack.stdout);
const rootPackage = Array.isArray(rootParsed) ? rootParsed[0] : Object.values(rootParsed)[0];
assert.equal(rootPackage.name, '@saifymatteo/pi-extensions');
const rootPaths = rootPackage.files.map(file => file.path);
for (const required of ['package.json', 'README.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE', 'inventory.json']) assert.ok(rootPaths.includes(required), `root: missing ${required}`);
for (const entry of inventory.extensions) {
  for (const required of [`packages/${entry.directory}/src/index.ts`, `packages/${entry.directory}/package.json`, `packages/${entry.directory}/CHANGELOG.md`]) {
    assert.ok(rootPaths.includes(required), `root: collection tarball missing ${required}`);
  }
}
assert.ok(rootPaths.includes('packages/pi-vision/skills/vision-tools/SKILL.md'), 'root: collection tarball missing the vision-tools skill');
console.log(`PASS ${rootPackage.name}: ${rootPaths.length} prospective files (collection)`);
for (const pkg of packages) {
  const paths = pkg.files.map(file => file.path);
  for (const required of ['package.json', 'src/index.ts', 'README.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE']) assert.ok(paths.includes(required), `${pkg.name}: missing ${required}`);
  if (JSON.parse(readFileSync(resolve(root, 'packages', pkg.name.replace('@saifymatteo/', ''), 'package.json'), 'utf8')).pi?.skills) {
    assert.ok(paths.some(path => path.startsWith('skills/')), `${pkg.name}: bundled skill missing from tarball`);
  }
  for (const path of paths) assert.ok(['package.json', 'README.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE'].includes(path) || path.startsWith('src/') || path.startsWith('examples/') || path.startsWith('skills/'), `${pkg.name}: unexpected packed file ${path}`);
  console.log(`PASS ${pkg.name}: ${paths.length} prospective files`);
}
console.log(`Verified ${packages.length} standalone package file lists. No archives created or packages published.`);

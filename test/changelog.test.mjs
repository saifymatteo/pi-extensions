import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, getNewEntries, parseChangelog } from '../node_modules/@earendil-works/pi-coding-agent/dist/utils/changelog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(readFileSync(resolve(root, 'inventory.json'), 'utf8'));

for (const directory of ['.', ...inventory.extensions.map(({ directory }) => `packages/${directory}`)]) {
  const packageRoot = resolve(root, directory);
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  test(`${pkg.name}: native changelog has released notes and excludes unreleased work`, () => {
    const path = resolve(packageRoot, pkg.pi.changelogPath ?? 'CHANGELOG.md');
    const markdown = readFileSync(path, 'utf8');
    assert.ok(pkg.files.includes('CHANGELOG.md'), 'release notes must ship');
    assert.match(markdown, /^## \[Unreleased\]\r?$/m);
    const entries = parseChangelog(path);
    const versions = entries.map(({ major, minor, patch }) => `${major}.${minor}.${patch}`);
    assert.equal(versions[0], pkg.version, 'latest released heading must match the manifest');
    for (const [index, entry] of entries.entries()) {
      assert.match(entry.content, /^- .+/m, 'each release needs a user-facing note');
      assert.doesNotMatch(entry.content, /^## \[Unreleased\]/m);
      if (index) assert.ok(compareVersions(entries[index - 1], entry) > 0, 'versions must be unique and newest first');
    }
    assert.deepEqual(getNewEntries(entries, pkg.version), [], 'unreleased notes must not trigger an update');
    assert.deepEqual(getNewEntries(entries, versions[1] ?? '0.0.0'), [entries[0]], 'an upgrade must expose the new release');
  });
}

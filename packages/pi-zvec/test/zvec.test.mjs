import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';
const Type = new Proxy({}, { get: () => () => ({}) });
const mod = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type } });

test('exact search preserves regex and glob arguments without index flags', () => {
  assert.equal(JSON.stringify(mod.buildSearchArgs({ query: 'a|b', mode: 'exact', globs: ['!vendor/**'], fileTypes: ['ts'], limit: 9 })), JSON.stringify(['--rg', '-n', '-e', 'a|b', '-g', '!vendor/**', '-t', 'ts']));
  assert.equal(mod.buildSearchArgs({ query: '-word', mode: 'exact' }).join('|'), '--rg|-n|-e|-word');
});

test('indexed search uses explicit query routes without legacy subcommands', () => {
  for (const [mode, route] of [['fts', '--fts'], ['vector', '--vector'], ['hybrid', '--hybrid'], ['auto', '--hybrid'], [undefined, '--hybrid']]) {
    assert.equal(JSON.stringify(mod.buildSearchArgs({ query: 'symbol', mode, limit: 2, globs: ['!vendor/**'], fileTypes: ['ts'] })), JSON.stringify([route, 'symbol', '--limit', '2', '-g', '!vendor/**', '-t', 'ts']));
  }
});

test('an empty workspace index is a successful no-op, not a missing index', () => {
  const output = `Workspace index
files   0 scanned, 0 added, 0 modified, 0 retried, 0 unchanged, 0 deleted, 0 failed
entities   0
duration   0ms (0ms)
roots   /home/matteo/Downloads
tip   No indexable files were found. Run \`zg --help file-types\` to review supported file types and indexing rules.

Scanning — scanning files
Indexing: 0/0 files
Optimizing index: 0/0 files
Saving index: 0/0 files
Finishing index: 0/0 files`;
  assert.equal(mod.hasFailureText(output), false);
});

test('index success counters and output freshness are interpreted correctly', () => {
  assert.equal(mod.hasFailureText('10 indexed, 0 failed'), false);
  assert.equal(mod.hasFailureText('10 indexed, 1 failed'), true);
  for (const error of ['No index found', 'No such index', 'Index not initialized', '✗ indexing error']) {
    assert.equal(mod.hasFailureText(error), true, error);
  }
  const summary = mod.summarizeOutput('hits: 3\nfreshness: possibly_stale');
  assert.equal(summary.hits, 3);
  assert.equal(summary.fresh, 'possibly_stale');
});

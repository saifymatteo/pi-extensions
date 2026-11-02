import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';
const Type = new Proxy({}, { get: () => () => ({}) });
const mod = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type } });

test('exact search preserves regex and glob arguments without index flags', () => {
  assert.equal(JSON.stringify(mod.buildSearchArgs({ query: 'a|b', mode: 'exact', globs: ['!vendor/**'], fileTypes: ['ts'], limit: 9 })), JSON.stringify(['query', '--rg', '-n', 'a|b', '-g', '!vendor/**', '-t', 'ts']));
  assert.equal(mod.buildSearchArgs({ query: 'symbol', mode: 'fts', limit: 2 }).join('|'), 'query|--fts|symbol|--limit|2');
});

test('index success counters and output freshness are interpreted correctly', () => {
  assert.equal(mod.hasFailureText('10 indexed, 0 failed'), false);
  assert.equal(mod.hasFailureText('10 indexed, 1 failed'), true);
  const summary = mod.summarizeOutput('hits: 3\nfreshness: possibly_stale');
  assert.equal(summary.hits, 3);
  assert.equal(summary.fresh, 'possibly_stale');
});

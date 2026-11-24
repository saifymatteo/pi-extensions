import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

test('explore delegates query and source limit to CLI without session-start side effects', async () => {
  let tool;
  const calls = [];
  const Type = new Proxy({}, { get: () => () => ({}) });
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type } });
  extension({ registerTool: value => { tool = value; }, registerCommand() {}, on() {}, exec: async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: args.includes('version') ? '1.0' : 'symbol source', stderr: '' };
  } });
  const result = await tool.execute('test', { query: 'findCaller', path: 'fixture-project', maxFiles: 3 }, undefined, undefined, { cwd: 'unused' });
  assert.equal(tool.name, 'codegraph_explore');
  assert.equal(result.content[0].text, 'symbol source');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.slice(-5).join('|'), 'findCaller|-p|fixture-project|--max-files|3');
  assert.equal(calls[1].options.timeout, 120000);
});

test('schema properties match the default config keys plus $schema', async () => {
  const { readFileSync, mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const T = new Proxy({}, { get: () => () => ({}) });
  const m = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type: T } });
  const schema = JSON.parse(readFileSync(new URL('../schemas/codegraph.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties).sort(), [...Object.keys(m.DEFAULTS), '$schema'].sort());
  assert.equal(schema.$id, m.SCHEMA_URL);
  assert.equal(m.SCHEMA_URL, 'https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/pi-codegraph/schemas/codegraph.schema.json');

  // Project config: .pi/extensions/ wins; the older .pi/ path is a read-only fallback.
  const root = mkdtempSync(join(tmpdir(), 'pi-codegraph-cfg-'));
  assert.equal(m.projectConfigPath(root), join(root, '.pi', 'extensions', 'codegraph.json'));
  mkdirSync(join(root, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(root, '.pi', 'codegraph.json'), '{}');
  assert.equal(m.projectConfigPath(root), join(root, '.pi', 'codegraph.json'));
  writeFileSync(join(root, '.pi', 'extensions', 'codegraph.json'), '{}');
  assert.equal(m.projectConfigPath(root), join(root, '.pi', 'extensions', 'codegraph.json'));
});

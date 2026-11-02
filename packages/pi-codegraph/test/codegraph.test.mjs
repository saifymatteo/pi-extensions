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

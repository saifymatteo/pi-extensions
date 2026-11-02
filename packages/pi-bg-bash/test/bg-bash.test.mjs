import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

test('foreground tool delegates unchanged; hook injects timeouts and blocks sleep waits', async () => {
  const tools = [];
  const handlers = new Map();
  const calls = [];
  const Type = new Proxy({}, { get: () => () => ({}) });
  const builtIn = () => ({ description: '', execute: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'fixture output' }] }; } });
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), {
    typebox: { Type },
    'node:fs': { ...fs, readdirSync: () => [], readFileSync: () => { throw new Error('no fixture settings'); } },
    '@earendil-works/pi-coding-agent': { createBashTool: builtIn, createPowerShellTool: builtIn },
    '@earendil-works/pi-tui': {},
  });
  extension({ registerTool: tool => tools.push(tool), registerToolRenderer() {}, registerMessageRenderer() {},
    registerCommand() {}, events: { on() {} }, on: (event, handler) => handlers.set(event, handler) });
  assert.equal(tools[0].name, 'bash');
  const result = await tools[0].execute('fixture', { command: 'echo test', timeout: 5 }, undefined, undefined, {});
  assert.equal(result.content[0].text, 'fixture output');
  assert.equal(calls[0][1].command, 'echo test');
  assert.equal(calls[0][1].timeout, 5);
  const input = { command: 'echo test' };
  await handlers.get('tool_call')({ toolName: 'bash', input });
  assert.equal(input.timeout, 120);
  const blocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'sleep 30' } });
  assert.equal(blocked.block, true);
  const background = { command: 'echo test', background: true };
  await handlers.get('tool_call')({ toolName: 'bash', input: background });
  assert.equal(background.timeout, undefined);
});

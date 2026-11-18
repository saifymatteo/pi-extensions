import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadExtension } from '../../../test/load-extension.mjs';

function start(agentDir) {
  const ext = loadExtension(new URL('../src/index.ts', import.meta.url), {
    '@earendil-works/pi-coding-agent': { getAgentDir: () => agentDir },
  });
  const handlers = {}; const shortcuts = {};
  ext.default({ on: (event, handler) => { handlers[event] = handler; }, registerShortcut: (key, opts) => { shortcuts[key] = opts.handler; } });
  const ui = {
    text: '', notes: [], keys: [], status: undefined,
    theme: { fg: (_color, text) => text },
    setStatus: (key, text) => { assert.equal(key, 'draft'); ui.status = text; },
    getEditorText: () => ui.text,
    setEditorText: text => { ui.text = text; },
    notify: message => ui.notes.push(message),
    onTerminalInput: handler => ui.keys.push(handler),
  };
  const ctx = { hasUI: true, cwd: '/work/project', ui };
  handlers.session_start({}, ctx);
  return { ext, ui, save: () => shortcuts['alt+s'](ctx), type: text => { ui.keys.forEach(k => k('x')); ui.text = text; }, quit: () => handlers.session_shutdown({}, ctx) };
}

test('autosaves the unsent prompt and restores it in the same folder after restart', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-draft-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const first = start(agentDir);
  const file = first.ext.draftPath('/work/project');
  assert.equal(first.ui.notes.length, 0, 'nothing to restore yet');
  assert.equal(first.ui.status, undefined, 'no draft, no status');

  first.save();
  assert.deepEqual(first.ui.notes, ['Nothing to save: the editor is empty']);
  first.ui.notes.length = 0;

  first.type('half-written prompt');
  await sleep(400);
  assert.equal(readFileSync(file, 'utf8'), 'half-written prompt', 'saved after typing pauses (survives a kill)');
  assert.equal(first.ui.status, '✎ draft saved');

  first.type('saved by hand');
  first.save();
  assert.equal(readFileSync(file, 'utf8'), 'saved by hand', 'Alt+S saves without waiting');
  assert.deepEqual(first.ui.notes, ['Draft saved']);

  first.ui.text = 'half-written prompt, finished';
  first.quit();
  assert.equal(readFileSync(file, 'utf8'), 'half-written prompt, finished', 'quit saves without waiting');

  const second = start(agentDir);
  assert.equal(second.ui.text, 'half-written prompt, finished');
  assert.deepEqual(second.ui.notes, ['Restored unsent draft']);
  assert.equal(second.ui.status, '✎ draft saved');
  assert.notEqual(second.ext.draftPath('/work/other'), file, 'other folders keep their own draft');

  second.type(''); // sent or cleared
  await sleep(400);
  assert.equal(existsSync(file), false, 'empty editor deletes the draft');
  assert.equal(second.ui.status, undefined, 'status clears with the draft');
});

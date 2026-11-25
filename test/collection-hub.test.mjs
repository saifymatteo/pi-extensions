// /pi-extensions (collection only): package on/off saved to pi-extensions.json, and a picker that runs
// each loaded package's own settings command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtension } from './load-extension.mjs';

const tui = await import('@earendil-works/pi-tui');
const theme = { fg: (_c, t) => t, bold: t => t };
const inventory = JSON.parse(readFileSync(new URL('../inventory.json', import.meta.url), 'utf8'));

function setup(t, { commands = [], idle = true } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-collection-hub-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const hub = loadExtension(new URL('../collection/pi-extensions.ts', import.meta.url), { '@earendil-works/pi-tui': tui }, {
    process: { ...process, env: { PATH: process.env.PATH, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir } },
  });
  const registered = {};
  const sent = [];
  hub.default({
    registerCommand: (name, command) => { registered[name] = command; },
    getCommands: () => commands.map(name => ({ name, source: 'extension' })),
    sendUserMessage: (text, options) => sent.push({ text, options }),
  });
  return { hub, agentDir, command: registered['pi-extensions'], sent, idle };
}

function ctx({ keys = [], select, idle = true, notes = [] }) {
  return {
    hasUI: true, mode: 'tui', isIdle: () => idle,
    ui: {
      notify: message => notes.push(message),
      select: async (_title, options) => select?.(options),
      custom: factory => new Promise(resolve => {
        const dialog = factory({ requestRender() {} }, theme, {}, resolve);
        for (const key of keys) dialog.handleInput(key);
      }),
    },
  };
}

test('/pi-extensions settings turns a package off and back on in pi-extensions.json', async t => {
  const h = setup(t);
  const index = inventory.extensions.findIndex(e => e.directory === 'pi-tts');
  const toggleTts = [...Array(index).fill('\u001b[B'), ' ', String.fromCharCode(19)];
  await h.command.handler('settings', ctx({ keys: toggleTts }));
  const file = join(h.agentDir, 'extensions', 'pi-extensions.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.disabled, ['pi-tts']);
  assert.match(saved.$schema, /pi-extensions\.schema\.json$/);
  await h.command.handler('settings', ctx({ keys: toggleTts }));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).disabled, []);
});

test('/pi-extensions lists only loaded settings commands and runs the chosen one', async t => {
  const h = setup(t, { commands: ['ide', 'codegraph'] });
  let offered;
  await h.command.handler('', ctx({ select: options => { offered = [...options]; return options.find(o => o.startsWith('pi-codegraph')); } }));
  assert.deepEqual(offered, ['Packages: turn on or off', 'pi-x-ide  /ide settings', 'pi-codegraph  /codegraph settings']);
  assert.deepEqual(h.sent.map(s => ({ text: s.text, options: { ...s.options } })), [{ text: '/codegraph settings', options: { expandPromptTemplates: true } }]);
});

test('/pi-extensions waits while the agent is busy instead of queueing a command', async t => {
  const h = setup(t, { commands: ['ide'] });
  const notes = [];
  await h.command.handler('', ctx({ idle: false, notes, select: options => options[1] }));
  assert.deepEqual(h.sent, []);
  assert.match(notes[0], /run \/ide settings yourself/);
});

test('every settings command in the hub belongs to a real package', t => {
  const { hub } = setup(t);
  const packages = new Set(inventory.extensions.map(e => e.directory));
  for (const { pkg } of hub.SETTINGS_COMMANDS) assert.ok(packages.has(pkg), pkg);
});

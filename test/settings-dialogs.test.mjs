// Every package with a `/<command> settings` dialog: the dialog lists each simple schema property
// (boolean, enum, number, short text) and saves through real keystrokes. See AGENTS.md "Settings dialogs".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadExtension } from './load-extension.mjs';

const require = createRequire(import.meta.url);
const tui = await import('@earendil-works/pi-tui');
const Type = new Proxy({}, { get: () => () => ({}) });
const theme = { fg: (_c, t) => t, bold: t => t };
const KEY = { enter: '\r', space: ' ', ctrlS: String.fromCharCode(19), down: '\u001b[B' };

// package, command, config file, schema, fields intentionally JSON-only.
const DIALOGS = [
  { pkg: 'pi-codegraph', command: 'codegraph', file: 'codegraph.json', jsonOnly: [] },
  { pkg: 'pi-zvec', command: 'zvec', file: 'zvec.json', jsonOnly: [] },
  { pkg: 'pi-9router', command: '9router', file: '9router.json', jsonOnly: [], globalOnly: true },
  { pkg: 'pi-vision', command: 'vision', file: 'vision-toolkit.json', jsonOnly: [], globalOnly: true },
];

function simpleKeys(schema) {
  const simple = prop => !prop.deprecated && (['boolean', 'integer', 'number', 'string'].includes(prop.type) || Array.isArray(prop.enum));
  return Object.entries(schema.properties).filter(([key, prop]) => key !== '$schema' && simple(prop)).map(([key]) => key);
}

function load(pkg, agentDir) {
  const anything = new Proxy({}, { get: () => () => ({}) });
  const stubs = {
    typebox: { Type }, '@earendil-works/pi-tui': tui, '@earendil-works/pi-ai': anything,
    '@xynogen/pix-pretty/utils': anything, '@xynogen/pix-runtime/collapse': anything, '@xynogen/pix-runtime/io': anything,
  };
  return loadExtension(new URL(`../packages/${pkg}/src/index.ts`, import.meta.url), stubs, {
    // A fresh agent dir and no router env: no credentials, so nothing touches the network.
    process: { ...process, env: { PATH: process.env.PATH, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir } },
  });
}

for (const { pkg, command, file, jsonOnly, globalOnly } of DIALOGS) {
  const schema = require(`../packages/${pkg}/schemas/${file.replace('.json', '.schema.json')}`);

  test(`${pkg}: /${command} settings lists every simple schema property`, () => {
    const { SETTINGS_FIELDS } = load(pkg, tmpdir());
    const listed = SETTINGS_FIELDS.map(field => field.key.split('.')[0]);
    // Object properties whose leaves are all simple count too (pi-9router `tools`).
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.type === 'object' && prop.properties && !listed.includes(key)) continue;
    }
    for (const key of simpleKeys(schema)) {
      if (!jsonOnly.includes(key)) assert.ok(listed.includes(key), `${key} is missing from /${command} settings`);
    }
  });

  test(`${pkg}: /${command} settings saves a changed field to the global file`, { timeout: 10_000 }, async t => {
    const agentDir = mkdtempSync(join(tmpdir(), `${pkg}-settings-`));
    const cwd = mkdtempSync(join(tmpdir(), `${pkg}-cwd-`));
    t.after(() => { rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
    const commands = {};
    const extension = load(pkg, agentDir);
    await extension.default({
      registerTool() {}, registerCommand: (name, cmd) => { commands[name] = cmd; }, registerShortcut() {}, on() {},
      registerProvider() {}, unregisterProvider() {}, exec: async () => ({ code: 1, stdout: '', stderr: '' }),
    });
    const notes = [];
    let frame = '';
    const ctx = {
      cwd, hasUI: true, mode: 'tui',
      ui: {
        notify: message => notes.push(message),
        custom: factory => new Promise(resolve => {
          const dialog = factory({ requestRender() {} }, theme, {}, resolve);
          frame = dialog.render(200).join('\n');
          const downs = Array(extension.SETTINGS_FIELDS.findIndex(f => f.type !== 'text')).fill(KEY.down);
          for (const key of [...(globalOnly ? [] : ['1']), ...downs, KEY.space, KEY.ctrlS]) dialog.handleInput(key);
        }),
      },
    };
    await commands[command].handler('settings', ctx);
    if (globalOnly) assert.match(frame, /· Global/);
    else assert.match(frame, /1\. Global/), assert.match(frame, /2\. Project/);
    const field = extension.SETTINGS_FIELDS.find(f => f.type !== 'text');
    const saved = JSON.parse(readFileSync(join(agentDir, 'extensions', file), 'utf8'));
    assert.equal(saved.$schema, schema.$id);
    assert.notEqual(field.key.split('.').reduce((node, part) => node?.[part], saved), undefined, `${field.key} saved`);
    assert.match(notes.at(-1), /Saved Global settings/);
  });
}

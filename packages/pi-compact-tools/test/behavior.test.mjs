import test from 'node:test';
import assert from 'node:assert/strict';
import * as tui from '@earendil-works/pi-tui';
import { loadExtension } from '../../../test/load-extension.mjs';

const theme = { fg: (_token, text) => text, bold: text => text };
const assistant = content => ({ role: 'assistant', content });
const call = id => ({ type: 'toolCall', id, name: 'bash', arguments: { command: id } });
const user = text => ({ role: 'user', content: text });

function harness(t) {
  const hooks = {};
  const branch = [];
  let resolver;
  let activity;
  const invalidated = [];
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
    '@earendil-works/pi-coding-agent': {
      AssistantMessageComponent: class { updateContent() {} },
      ToolExecutionComponent: class {},
      keyHint: (_key, label) => `Ctrl+O ${label}`,
    },
    '@earendil-works/pi-tui': tui,
  }, {
    // No wall-clock animation needed to check card ownership.
    setInterval: fn => { activity = fn; return 1; },
    clearInterval: () => { activity = undefined; },
  });
  extension.default({
    on: (name, handler) => { hooks[name] = handler; },
    registerToolRenderer: fn => { resolver = fn; },
    getSettings: () => ({}),
  });
  const emit = (name, message) => hooks[name]?.({ message });
  hooks.session_start({}, { sessionManager: {
    getSessionId: () => 'test',
    getLeafId: () => branch.at(-1)?.id,
    getBranch: () => branch,
  } });
  t.after(() => emit('session_shutdown'));
  const persist = message => branch.push({ type: 'message', id: String(branch.length), message });
  const render = id => resolver('bash', () => undefined).renderCall({ command: id }, theme, {
    toolCallId: id, [Symbol.for('compact-tools.tuiContext')]: true,
    expanded: false, isPartial: false, invalidate: () => invalidated.push(id),
  }).render(90).join('\n');
  return { emit, persist, render, invalidated, tick: () => activity?.() };
}

test('new request thinking does not appear in the previous tool card', t => {
  const h = harness(t);
  h.persist(user('first request'));
  h.persist(assistant([call('old')]));
  h.emit('agent_end');
  const before = h.render('old');
  assert.match(before, /Ran 1 command/);

  h.emit('agent_start');
  h.emit('message_start', user('second request'));
  h.persist(user('second request'));
  h.emit('message_start', assistant([]));
  h.emit('message_update', assistant([{ type: 'thinking', thinking: 'NEW REQUEST THOUGHT' }]));
  assert.equal(h.render('old'), before, 'previous card must not show new request activity');
});

test('new tool calls stay below the user boundary, live and persisted', t => {
  const h = harness(t);
  h.persist(user('first request'));
  h.persist(assistant([call('old')]));
  const before = h.render('old');
  h.emit('agent_start');
  h.emit('message_start', user('second request'));
  h.persist(user('second request'));
  h.emit('message_start', assistant([]));
  h.emit('message_update', assistant([call('new')]));
  assert.match(h.render('new'), /Ran 1 command/);
  assert.equal(h.render('old'), before);
  h.persist(assistant([call('new')]));
  assert.match(h.render('new'), /Ran 1 command/, 'persisted/live duplicate must not count twice');
  h.emit('agent_end');
  assert.match(h.render('new'), /Ran 1 command/);
  assert.equal(h.render('old'), before);
});

test('a steering user boundary stops previous card activity before persistence', t => {
  const h = harness(t);
  h.persist(user('first request'));
  h.persist(assistant([call('old')]));
  const before = h.render('old');
  h.emit('agent_start');
  h.emit('message_start', assistant([{ type: 'thinking', thinking: 'OLD THOUGHT' }]));
  assert.match(h.render('old'), /OLD THOUGHT/);
  h.emit('message_start', user('steering request'));
  assert.equal(h.render('old'), before);
  h.invalidated.length = 0;
  h.tick();
  assert.equal(h.invalidated.length, 0, 'old card animation stops at the pending boundary');
  h.persist(user('steering request'));
  h.emit('message_start', assistant([]));
  h.emit('message_update', assistant([call('new')]));
  assert.match(h.render('new'), /Ran 1 command/);
  assert.equal(h.render('old'), before);
  h.invalidated.length = 0;
  h.tick();
  assert.deepEqual(h.invalidated, ['new'], 'animation now belongs to the new card');
});

test('assistant text ends the active card while thinking alone preserves it', t => {
  const h = harness(t);
  h.persist(user('request'));
  h.persist(assistant([call('first')]));
  const before = h.render('first');
  h.emit('agent_start');
  h.emit('message_start', assistant([]));
  h.emit('message_update', assistant([{ type: 'thinking', thinking: 'SAME REQUEST' }]));
  assert.match(h.render('first'), /SAME REQUEST/);
  h.emit('message_update', assistant([
    { type: 'thinking', thinking: 'SAME REQUEST' },
    { type: 'text', text: 'Visible response' },
  ]));
  assert.equal(h.render('first'), before);
});

test('consecutive tool-only assistant messages still share one card', t => {
  const h = harness(t);
  h.persist(user('request'));
  h.persist(assistant([call('first')]));
  h.emit('message_start', assistant([]));
  h.emit('message_update', assistant([call('second')]));
  assert.match(h.render('first'), /Ran 2 commands/);
  assert.equal(h.render('second'), '');
});

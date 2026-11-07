import test from 'node:test';
import assert from 'node:assert/strict';
import * as tui from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup({ mode = 'tui', hasUI = true, confirm = true, answers = [] } = {}) {
  const timers = new Set(), notifications = [], stopped = [], confirmations = [], selections = [...answers];
  const { showJobPanel } = loadExtension(fileURLToPath(new URL('../src/lib/panel.ts', import.meta.url)), {
    '@earendil-works/pi-tui': tui,
  }, {
    setInterval: callback => { const timer = { callback }; timers.add(timer); return timer; },
    clearInterval: timer => timers.delete(timer),
  });
  const jobs = [{ id: 2, tool: 'bash', command: 'npm run dev', state: 'running', secs: 10, running: true, stoppable: true },
    { id: 1, tool: 'powershell', command: 'npm test', state: 'done', secs: 4, running: false, stoppable: false }];
  let component, output = 'line 1\nline 2\nline 3\nline 4';
  const controller = new AbortController();
  const ctx = { mode, hasUI, ui: {
    notify: (...args) => notifications.push(args),
    confirm: async (...args) => { confirmations.push(args); return confirm; },
    select: async (_title, options) => { const answer = selections.shift(); return typeof answer === 'number' ? options[answer] : answer; },
    custom: factory => new Promise(resolve => {
      component = factory({ terminal: { rows: 8 }, requestRender() {} },
        { fg: (_color, text) => text }, {}, value => { component?.dispose?.(); resolve(value); });
    }),
  } };
  const controls = { list: () => jobs, output: () => output, stop: async (id, mode) => { stopped.push([id, mode]); jobs[0].running = false; return 'stopped'; } };
  const result = showJobPanel(ctx, controls, controller.signal);
  return { result, jobs, timers, stopped, confirmations, notifications, selections, controller,
    get component() { return component; }, get output() { return output; }, set output(value) { output = value; },
    refresh: () => { for (const timer of timers) timer.callback(); },
  };
}

test('x confirms before stopping; refusing or closing never stops a job', async () => {
  for (const confirm of [true, false]) {
    const s = setup({ confirm });
    s.component.handleInput('x');
    await flush();
    assert.equal(s.confirmations.length, 1);
    assert.deepEqual(s.stopped, confirm ? [[2, 'force']] : []);
    assert.match(s.confirmations[0][0], /Force kill/);
    assert.match(s.confirmations[0][1], /Cleanup hooks will not run/);
    s.component.handleInput('\x1b');
    await s.result;
    assert.equal(s.timers.size, 0);
  }
  const s = setup();
  s.component.handleInput('q');
  await s.result;
  assert.equal(s.stopped.length, 0);
});

test('s requests graceful stopping, independently confirmed and without escalation', async () => {
  for (const confirm of [true, false]) {
    const s = setup({ confirm });
    s.component.handleInput('s');
    await flush();
    assert.match(s.confirmations[0][0], /Gracefully stop/);
    assert.match(s.confirmations[0][1], /no automatic escalation/);
    assert.deepEqual(s.stopped, confirm ? [[2, 'graceful']] : []);
    s.component.handleInput('q');
    await s.result;
    assert.equal(s.timers.size, 0);
  }
});

test('list refresh preserves the selected job as rows change', async () => {
  const s = setup();
  s.component.handleInput('\x1b[B');
  s.jobs.unshift({ id: 3, tool: 'bash', command: 'new', state: 'running', secs: 1, running: true, stoppable: true });
  s.refresh();
  s.component.handleInput('x');
  await flush();
  assert.equal(s.confirmations.length, 0, 'selected completed job is still selected');
  assert.match(s.notifications.at(-1)[0], /#1 already finished/);
  s.component.handleInput('q');
  await s.result;
});

test('output follows the bottom, preserves scroll-up, and all rendered lines fit narrow widths', async () => {
  const s = setup();
  s.component.handleInput('\r');
  await flush();
  let lines = s.component.render(40).map(line => line.trimEnd());
  assert.ok(lines.includes('line 4'));
  s.component.handleInput('\x1b[H');
  lines = s.component.render(40).map(line => line.trimEnd());
  assert.ok(lines.includes('line 1'));
  s.output = 'line 1\nline 2\nline 3\nline 4\nline 5';
  s.refresh();
  lines = s.component.render(40).map(line => line.trimEnd());
  assert.ok(lines.includes('line 1'));
  assert.ok(!lines.includes('line 5'));
  s.component.handleInput('\x1b[F');
  s.component.render(40);
  s.output += '\nline 6';
  s.refresh();
  assert.ok(s.component.render(40).some(line => line.trimEnd() === 'line 6'));
  s.output = '界'.repeat(100);
  s.refresh();
  assert.ok(s.component.render(9).every(line => tui.visibleWidth(line) <= 9));
  s.component.handleInput('\x1b');
  await flush();
  assert.equal(s.timers.size, 1, 'only the reopened list refreshes');
  s.controller.abort();
  await s.result;
  assert.equal(s.timers.size, 0);
});

test('session invalidation closes an open output view and clears its timer', async () => {
  const s = setup();
  s.component.handleInput('\r');
  await flush();
  s.controller.abort();
  await s.result;
  assert.equal(s.timers.size, 0);
  assert.equal(s.stopped.length, 0);
});

test('non-UI mode is list-only, and RPC uses explicit view/stop choices', async () => {
  const noUI = setup({ mode: 'print', hasUI: false });
  await noUI.result;
  assert.match(noUI.notifications[0][0], /npm run dev/);
  assert.equal(noUI.stopped.length, 0);
  assert.equal(noUI.timers.size, 0);

  const rpc = setup({ mode: 'rpc', answers: [0, 'View output', 0, 'Stop gracefully'] });
  await rpc.result;
  assert.match(rpc.notifications[0][0], /line 1/);
  assert.deepEqual(rpc.stopped, [[2, 'graceful']]);
  assert.equal(rpc.confirmations.length, 1);
  assert.equal(rpc.timers.size, 0);

  const force = setup({ mode: 'rpc', answers: [0, 'Force kill'] });
  await force.result;
  assert.deepEqual(force.stopped, [[2, 'force']]);
  assert.match(force.confirmations[0][0], /Force kill/);

  const cancelled = setup({ mode: 'rpc' });
  await cancelled.result;
  assert.equal(cancelled.stopped.length, 0);
});

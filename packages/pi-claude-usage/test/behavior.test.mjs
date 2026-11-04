import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';

const cached = { fiveHour: { pct: 42, resetsAt: 4_000_000_000_000 } };

function harness(t, initialModel, cache = cached) {
  const hooks = {}, statuses = new Map(), timers = new Set(), writes = [];
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
    'node:fs': {
      readFileSync: () => {
        if (!cache) throw new Error('no cache');
        return JSON.stringify(cache);
      },
      mkdirSync: () => {},
      writeFileSync: (_path, contents) => writes.push(JSON.parse(contents)),
    },
  }, {
    setInterval: fn => { timers.add(fn); return fn; },
    clearInterval: fn => timers.delete(fn),
  });
  extension.default({ on: (name, fn) => { hooks[name] = fn; } });
  const ui = {
    setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
    theme: { fg: (_color, value) => value },
  };
  const context = model => ({ model, ui });
  const ctx = context(initialModel);
  t.after(() => hooks.session_shutdown());
  return {
    hooks, ctx, statuses, timers, writes,
    select: model => hooks.model_select({ model }, context(model)),
  };
}

for (const model of [undefined, { provider: 'openai', id: 'gpt-5' }, { provider: 'anthropic', id: 'claude-sonnet-4-6' }]) {
  test(`cached Claude usage stays hidden for ${model?.provider ?? 'no model'}`, async t => {
    const h = harness(t, model);
    await h.hooks.session_start({}, h.ctx);
    assert.equal(h.statuses.has('claude-usage'), false);
  });
}

test('model changes hide and restore cached usage immediately, including timer refreshes', async t => {
  const h = harness(t, { provider: 'claude-code', id: 'sonnet' });
  await h.hooks.session_start({}, h.ctx);
  assert.match(h.statuses.get('claude-usage'), /^Claude 5h 42%/);

  await h.select({ provider: 'openai', id: 'gpt-5' });
  assert.equal(h.statuses.has('claude-usage'), false);
  for (const refresh of h.timers) refresh();
  assert.equal(h.statuses.has('claude-usage'), false);

  await h.select({ provider: 'claude-code', id: 'sonnet' });
  assert.match(h.statuses.get('claude-usage'), /^Claude 5h 42%/);
});

test('diagnostics update the cache without exposing usage on another provider', async t => {
  const h = harness(t, { provider: 'openai', id: 'gpt-5' }, null);
  await h.hooks.session_start({}, h.ctx);
  await h.hooks.message_end({ message: {
    role: 'assistant',
    diagnostics: [{ type: 'claude-code.rate-limit', details: {
      unifiedWindows: { five_hour: { utilization: 0.75, resetsAt: 4_000_000_000 } },
    } }],
  } }, h.ctx);
  assert.equal(h.statuses.has('claude-usage'), false);
  assert.equal(h.writes.at(-1).fiveHour.pct, 75);
  await h.select({ provider: 'claude-code', id: 'sonnet' });
  assert.match(h.statuses.get('claude-usage'), /^Claude 5h 75%/);
});

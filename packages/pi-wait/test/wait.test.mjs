import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

function setup(providers) {
  let tool;
  const Type = new Proxy({}, { get: () => () => ({}) });
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), { typebox: { Type } });
  extension({ registerTool: value => { tool = value; }, events: { emit: (name, discovery) => {
    assert.equal(name, 'async-work:providers:v1');
    for (const provider of providers) discovery.add(provider);
  } } });
  return params => tool.execute('test', params, undefined, undefined, { sessionManager: { getSessionFile: () => 'fixture-session' } });
}

test('wait validates references before discovery', async () => {
  const run = setup([]);
  await assert.rejects(run({ jobs: ['shell:0'] }), /Invalid job reference/);
  await assert.rejects(run({ jobs: ['shell:1', 'shell:1'] }), /unique job references/);
  await assert.rejects(run({ jobs: ['shell:1'], timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(run({ jobs: ['shell:1'] }), /No shell provider/);
});

test('wait joins in requested order and commits then releases all leases', async () => {
  const actions = [];
  const provider = source => ({ source, claim: ids => ({
    result: Promise.resolve(ids.map(id => ({ source, id, content: `${source} output`, details: {} }))),
    commit: () => actions.push(`commit:${source}`), release: () => actions.push(`release:${source}`),
  }) });
  const result = await setup([provider('shell'), provider('agent')])({ jobs: ['agent:2', 'shell:1'] });
  assert.match(result.content[0].text, /^\[agent:2\][\s\S]*\[shell:1\]/);
  assert.equal(actions.join(','), 'commit:agent,commit:shell,release:agent,release:shell');
});

test('malformed provider output is released without consumption', async () => {
  let committed = false;
  let released = false;
  const run = setup([{ source: 'shell', claim: () => ({ result: Promise.resolve([]), commit: () => { committed = true; }, release: () => { released = true; } }) }]);
  await assert.rejects(run({ jobs: ['shell:1'] }), /Invalid provider result/);
  assert.equal(committed, false);
  assert.equal(released, true);
});

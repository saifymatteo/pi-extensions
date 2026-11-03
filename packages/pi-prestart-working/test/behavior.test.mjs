import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtension } from '../../../test/load-extension.mjs';

// Mirrors Pi's ExtensionRunner.emitBeforeAgentStart: snapshot handler lists
// synchronously, then await each handler in extension order.
class FakeRunner {
  log = [];
  extensions = [];
  uiContext = {
    setWorkingMessage: m => this.log.push(`msg:${m ?? '<default>'}`),
    setWorkingVisible: v => this.log.push(`visible:${v}`),
  };
  hasUI() { return true; }
  async emitBeforeAgentStart() {
    const snapshot = this.extensions.map(e => (e.handlers.get('before_agent_start') ?? []).slice());
    for (const handlers of snapshot) for (const h of handlers) await h();
    return 'result';
  }
}

test('labels the spinner with each blocking extension, then restores', async t => {
  const { default: install, extensionLabel } = loadExtension(new URL('../src/index.ts', import.meta.url), {
    '@earendil-works/pi-coding-agent': { ExtensionRunner: FakeRunner },
  });
  install();
  install(); // second load (e.g. /reload) must not double-wrap

  const pkgDir = mkdtempSync(join(tmpdir(), 'prestart-'));
  t.after(() => rmSync(pkgDir, { recursive: true, force: true }));
  mkdirSync(join(pkgDir, 'dist'));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@vectorize-io/hindsight-coding-agents' }));

  const runner = new FakeRunner();
  const slow = async () => { runner.log.push('run:hindsight'); };
  const fast = () => { runner.log.push('run:zvec'); };
  runner.extensions = [
    { path: join(pkgDir, 'dist', 'pi.js'), handlers: new Map([['before_agent_start', [slow]]]) },
    { path: '/x/extensions/zvec.ts', handlers: new Map([['before_agent_start', [fast]]]) },
    { path: '/x/extensions/other.ts', handlers: new Map() },
  ];

  assert.equal(await runner.emitBeforeAgentStart(), 'result');
  assert.deepEqual(runner.log, [
    'visible:true',
    'msg:Loading hindsight-coding-agents', 'run:hindsight',
    'msg:Loading zvec', 'run:zvec',
    'msg:<default>',
  ]);
  // Original handler arrays are back, so pi.on() unsubscribe still finds them.
  assert.equal(runner.extensions[0].handlers.get('before_agent_start')[0], slow);
  assert.equal(extensionLabel('/a/b/session-rename.ts'), 'session-rename');
});

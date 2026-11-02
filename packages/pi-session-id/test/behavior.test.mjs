import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';

for (const fail of [false, true]) {
  test('session-id command reports clipboard ' + (fail ? 'failure with recoverable ID' : 'success'), async () => {
    const copied = [], notices = [], commands = new Map();
    const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
      '@earendil-works/pi-coding-agent': {
        copyToClipboard: async id => { copied.push(id); if (fail) throw new Error('clipboard unavailable'); },
      },
    });
    extension.default({ registerCommand: (name, command) => commands.set(name, command) });
    assert.equal(commands.size, 1);
    await commands.get('session-id').handler('', {
      sessionManager: { getSessionId: () => 'fixture-session-id' },
      ui: { notify: (message, level) => notices.push({ message, level }) },
    });
    assert.deepEqual(copied, ['fixture-session-id']);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, fail ? 'error' : 'info');
    assert.match(notices[0].message, /fixture-session-id/);
    assert.match(notices[0].message, fail ? /Could not copy session ID:.*clipboard unavailable/ : /^Copied session ID:/);
  });
}

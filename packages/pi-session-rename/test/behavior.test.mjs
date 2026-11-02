import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';
test('child process guard prevents all title hooks and registrations', () => {
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {}, {
    process: { env: { PI_CHILD: '1' } },
  });
  extension.default(new Proxy({}, { get: () => { throw new Error('child registered behavior'); } }));
  assert.equal(typeof extension.default, 'function');
});

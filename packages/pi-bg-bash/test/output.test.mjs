import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtension } from '../../../test/load-extension.mjs';

const { cleanOutput, oneLine, readTail } = loadExtension(fileURLToPath(new URL('../src/lib/output.ts', import.meta.url)));

test('output removes terminal controls, preserves text, and command labels stay on one line', () => {
  assert.equal(cleanOutput('\x1b[31mred\x1b[0m\x1b]0;bad title\x07\x00\r\nnext\tcell'), 'red\nnext    cell');
  assert.equal(oneLine('npm\nrun\tdev\x1b[2J'), 'npm run dev');
});

test('tail reads cap both bytes and lines, even for a giant single line', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-bg-output-test-'));
  try {
    const file = join(root, 'out');
    writeFileSync(file, 'one\ntwo\nthree\n');
    assert.equal(readTail(file, 3), '(earlier output omitted)\ntwo\nthree');
    writeFileSync(file, 'x'.repeat(1024 * 1024));
    const tail = readTail(file, 2000, 1024);
    assert.match(tail, /^\(earlier output omitted\)/);
    assert.ok(tail.length < 1100);
    assert.equal(readTail(join(root, 'absent')), '(no output yet)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

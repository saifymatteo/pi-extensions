import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadExtension } from './load-extension.mjs';
import { isolatedEnvironment } from '../scripts/environment.mjs';

const source = new URL('../packages/pi-codeblock-borders/src/index.ts', import.meta.url);

// Pi-Bolt's top-level fast path calls codeBlockParts directly; nested code can
// still reach it through renderToken. Neither route should decorate twice.
test('codeblock patch covers the fast path and restores its owner on reload', () => {
  class Markdown {
    codeBlockParts(token) {
      return {
        before: [this.theme.codeBlockBorder('```' + token.lang)],
        code: this.theme.highlightCode(token.text, token.lang),
        after: [this.theme.codeBlockBorder('```')],
      };
    }
    renderToken(token, width) { return this.codeBlockParts(token, width); }
  }
  const originalParts = Markdown.prototype.codeBlockParts;
  const originalToken = Markdown.prototype.renderToken;
  const extension = loadExtension(source, { '@earendil-works/pi-tui': { Markdown, visibleWidth: s => [...s].length } });
  const install = () => {
    const hooks = {};
    extension.default({ on: (name, fn) => { hooks[name] = fn; } });
    return hooks;
  };
  const hooks = install();
  const component = new Markdown();
  const border = s => s;
  const highlight = (code, lang) => { assert.equal(lang, 'sh'); return code.split('\n'); };
  component.theme = { codeBlockBorder: border, highlightCode: highlight };
  const token = { lang: 'sh:line-numbers title="demo" {2}', text: 'first\nsecond' };
  for (const route of ['codeBlockParts', 'renderToken']) {
    const parts = component[route](token, 30);
    assert.equal(parts.before[0], 'sh── demo ' + '─'.repeat(20));
    assert.equal(parts.after[0], '─'.repeat(30));
    assert.equal(parts.code[0].match(/1 │/g).length, 1);
    assert.equal(parts.code[1].match(/2 │/g).length, 1);
    assert.equal(component.theme.codeBlockBorder, border);
    assert.equal(component.theme.highlightCode, highlight);
  }
  assert.equal(Markdown.prototype.renderToken, originalToken);

  // Preserve a later wrapper; our retained wrapper must become pass-through.
  const patched = Markdown.prototype.codeBlockParts;
  const later = function (...args) { return patched.apply(this, args); };
  Markdown.prototype.codeBlockParts = later;
  hooks.session_shutdown();
  assert.equal(Markdown.prototype.codeBlockParts, later);
  assert.equal(component.codeBlockParts({ lang: 'sh', text: 'plain' }, 30).before[0], '```sh');
  const replacement = install();
  hooks.session_shutdown(); // A stale shutdown must not remove the replacement.
  assert.notEqual(Markdown.prototype.codeBlockParts, later);
  assert.equal(component.codeBlockParts(token, 30).before[0].length, 30);
  replacement.session_shutdown();
  assert.equal(Markdown.prototype.codeBlockParts, later);
  assert.equal(Markdown.prototype.__codeblockBordersPatched, undefined);
  assert.notEqual(patched, originalParts);
});

const stockCli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
for (const host of [
  { name: 'stock Pi', command: process.execPath, args: [stockCli] },
  { name: 'PI_HOST', command: process.env.PI_HOST, args: [] },
]) {
  test(`codeblock borders render real Markdown on ${host.name}`, { skip: !host.command }, () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-codeblock-test-'));
    try {
      const resultFile = join(home, 'result.json');
      const probe = join(home, 'probe.ts');
      writeFileSync(probe, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import borders from ${JSON.stringify(fileURLToPath(source))};
export default function () {
  try {
    const proto = Markdown.prototype;
    const originalToken = proto.renderToken;
    const originalParts = proto.codeBlockParts;
    const hooks = {};
    borders({ on: (name, fn) => { hooks[name] = fn; } });
    const identity = s => s;
    const theme = Object.fromEntries(['heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote', 'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline'].map(key => [key, identity]));
    theme.highlightCode = (code, lang) => {
      assert.ok(['sh', 'text', ''].includes(lang), 'language must exclude fence decorations: ' + lang);
      return code.split('\\n');
    };
    const highlight = theme.highlightCode;
    const render = (text, width = 40) => {
      const lines = new Markdown(text, 0, 0, theme).render(width);
      assert.ok(lines.every(line => !line.includes('\x60\x60\x60')), 'literal fence: ' + JSON.stringify(lines));
      assert.ok(lines.every(line => visibleWidth(line) <= width), 'overflow: ' + JSON.stringify(lines));
      assert.equal(theme.codeBlockBorder, identity);
      assert.equal(theme.highlightCode, highlight);
      return lines;
    };
    const fence = '\x60\x60\x60';
    const plain = render(fence + 'sh\\necho probe\\n' + fence);
    assert.equal(plain[0], 'sh' + '─'.repeat(38));
    assert.equal(plain[plain.length - 1], '─'.repeat(40));
    const decorated = render(fence + 'sh:line-numbers=5 title="demo" {2}\\nfirst\\nsecond\\n' + fence);
    assert.equal(decorated[0], 'sh── demo ' + '─'.repeat(30));
    assert.equal(decorated[1].match(/5 │/g).length, 1);
    assert.equal(decorated[2].match(/6 │/g).length, 1);
    assert.ok(decorated[1].startsWith('  \\x1b[2m\\x1b[2m')); // Focus dims the numbered line, not the rule.
    assert.ok(decorated[2].includes('\\x1b[22msecond'));
    const quote = render('> ' + fence + 'sh:line-numbers\\n> echo quote\\n> ' + fence);
    assert.ok(quote.includes('│ sh' + '─'.repeat(36)), 'quote rule must use the inner width');
    const list = render('- item\\n\\n  ' + fence + 'sh:line-numbers\\n  echo list\\n  ' + fence);
    assert.ok(list.includes('  sh' + '─'.repeat(36)), 'list rule must use the inner width');
    render(fence + 'text title="測試"\\nx\\n' + fence, 12);
    render(fence + '\\nx\\n' + fence, 1);
    const streaming = new Markdown(fence + 'sh:line-numbers\\necho one', 0, 0, theme);
    for (const text of [fence + 'sh:line-numbers\\necho one', fence + 'sh:line-numbers\\necho one\\necho two\\n' + fence]) {
      streaming.setText(text);
      for (const width of [40, 20]) {
        const lines = streaming.render(width);
        assert.equal(lines[0], 'sh' + '─'.repeat(width - 2));
        assert.ok(lines.every(line => visibleWidth(line) <= width));
        assert.equal(lines.filter(line => line.includes('1 │')).length, 1);
      }
    }
    const throwingTheme = { ...theme, highlightCode() { throw new Error('highlighter failed'); } };
    const throwingHighlight = throwingTheme.highlightCode;
    assert.throws(() => new Markdown(fence + 'sh\\nx\\n' + fence, 0, 0, throwingTheme).render(40), /highlighter failed/);
    assert.equal(throwingTheme.codeBlockBorder, identity);
    assert.equal(throwingTheme.highlightCode, throwingHighlight);
    hooks.session_shutdown();
    assert.equal(proto.renderToken, originalToken);
    assert.equal(proto.codeBlockParts, originalParts);
    assert.equal(proto.__codeblockBordersPatched, undefined);
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ ok: true }));
  } catch (error) {
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ error: error.stack }));
  }
}
`);
      const child = spawnSync(host.command, [...host.args,
        '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
        '--no-mcp', '--no-context-files', '--no-session', '--no-approve', '-e', probe, '--help',
      ], { cwd: home, env: isolatedEnvironment(home), encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      let result;
      try { result = JSON.parse(readFileSync(resultFile, 'utf8')); }
      catch (error) { assert.fail(`${error.message}\n${child.stdout}\n${child.stderr}`); }
      assert.equal(result.ok, true, result.error);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadExtension } from './load-extension.mjs';

const source = name => new URL(`../packages/${name}/src/index.ts`, import.meta.url);

test('dotenv expands references without overwriting inherited values or looping on cycles', () => {
  const env = { PI_CODING_AGENT_DIR: join(tmpdir(), 'fake-agent'), KEEP: 'inherited' };
  const contents = 'KEEP=file\nBASE="hello"\nCOMPOSED=${BASE}/$KEEP\nMISSING=$NOT_SET\nA=$B\nB=$A\n# ignored\n';
  const extension = loadExtension(source('pi-load-pi-dotenv'), {
    'node:fs': { readFileSync: file => { assert.equal(file, join(env.PI_CODING_AGENT_DIR, '.env')); return contents; } },
  }, { process: { env } });
  extension.default();
  assert.equal(env.KEEP, 'inherited');
  assert.equal(env.COMPOSED, 'hello/inherited');
  assert.equal(env.MISSING, '$NOT_SET');
  assert.match(env.A, /\$[AB]/);
  assert.match(env.B, /\$[AB]/);
});

test('root guard respects directory boundaries and the tool session cwd', () => {
  const root = join(tmpdir(), 'fake-agent');
  const claude = join(tmpdir(), 'fake-claude');
  const guard = loadExtension(source('pi-root-guard'), {}, { process: { env: { PI_CODING_AGENT_DIR: root, CLAUDE_CONFIG_DIR: claude }, cwd: () => tmpdir() } });
  assert.equal(guard.blocked(join(root, 'settings.json')), true);
  assert.equal(guard.blocked(join(root, 'extensions', 'my-extension.ts')), false);
  assert.equal(guard.blocked(join(root + '-sibling', 'settings.json')), false);
  assert.equal(guard.protectedPath(join(claude, 'settings.json')), true);
  assert.equal(guard.protectedPath(join(claude, 'plans', 'plan.md')), false);
  let handler;
  guard.default({ on: (name, fn) => { assert.equal(name, 'tool_call'); handler = fn; } });
  assert.equal(handler({ toolName: 'write', input: { path: 'settings.json' } }, { cwd: root }).block, true);
  assert.equal(handler({ toolName: 'write', input: { path: 'extensions/new.ts' } }, { cwd: root }), undefined);
  assert.ok(guard.blockedBash('echo secret > settings.json', root));
  assert.equal(guard.blockedBash('echo "read only"', root), null);
  // Characterize a preserved source limitation, not desired shell semantics:
  // the heuristic also treats a quoted > as a possible write.
  assert.ok(guard.blockedBash('echo "not a redirection > settings.json"', root));
});

test('Claude diagnostic conversion and countdown format do not require provider calls', () => {
  const usage = loadExtension(source('pi-claude-usage'));
  assert.equal(usage.fromRateLimit(undefined), undefined);
  const result = usage.fromRateLimit({ unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 3600 } }, isUsingOverage: true });
  assert.equal(result.fiveHour.pct, 42);
  assert.equal(result.fiveHour.resetsAt, 3_600_000);
  assert.equal(usage.formatLeft(-10), '0m');
  assert.equal(usage.formatLeft(3_660_000), '1h01m');
  assert.equal(usage.formatFooter(result, 0), 'Claude 5h 42% ↻1h00m · 7d ? · overage');
  assert.match(usage.formatFooter(result, 3_600_001), /5h 0%/);
});

test('codeblock patch fits rules, restores theme callbacks, and unpatches on shutdown', () => {
  class Markdown {
    renderToken(token, width) {
      return [this.theme.codeBlockBorder('```' + token.lang), ...this.theme.highlightCode(token.text, token.lang), this.theme.codeBlockBorder('```')];
    }
  }
  const original = Markdown.prototype.renderToken;
  const hooks = {};
  loadExtension(source('pi-codeblock-borders'), { '@earendil-works/pi-tui': { Markdown, visibleWidth: text => [...text].length } }).default({ on: (name, fn) => { hooks[name] = fn; } });
  const theme = { codeBlockBorder: s => s, highlightCode: (code, lang) => { assert.equal(lang, 'ts'); return code.split('\n'); } };
  const border = theme.codeBlockBorder;
  const highlight = theme.highlightCode;
  const component = new Markdown(); component.theme = theme;
  const lines = component.renderToken({ lang: 'ts:line-numbers title="demo"', text: 'const x = 1;' }, 30);
  assert.equal(lines[0].length, 30);
  assert.match(lines[0], /demo/);
  assert.match(lines[1], /1 │/);
  assert.equal(theme.codeBlockBorder, border);
  assert.equal(theme.highlightCode, highlight);
  hooks.session_shutdown();
  assert.equal(Markdown.prototype.renderToken, original);
});

test('image previews store only source references and do not duplicate model payloads', () => {
  const hooks = {}, entries = [], renderers = {};
  const uiStub = { getCellDimensions: () => ({ widthPx: 8 }), getImageDimensions: () => null, Image: class {}, truncateToWidth: s => s };
  const pi = {
    on: (name, fn) => { hooks[name] = fn; },
    registerEntryRenderer: (name, fn) => { renderers[name] = fn; },
    getSettings: () => ({ terminal: { showImages: true } }),
    appendEntry: (customType, data) => { entries.push({ id: 'preview', type: 'custom', customType, data }); },
  };
  loadExtension(source('pi-user-image-previews'), { '@earendil-works/pi-tui': uiStub }).default(pi);
  const sm = { getLeafId: () => null, getBranch: () => entries, getEntry: id => entries.find(e => e.id === id) };
  const ctx = { mode: 'tui', sessionManager: sm };
  hooks.session_start({}, ctx);
  const message = { role: 'user', content: [{ type: 'image', data: 'private-image-bytes', mimeType: 'image/png' }] };
  hooks.message_end({ message }, ctx);
  entries.push({ id: 'user1', type: 'message', message });
  hooks.context({ messages: [message] }, ctx);
  assert.equal(entries.length, 2);
  assert.equal(JSON.stringify(entries[1].data), '{"messageId":"user1"}');
  hooks.context({ messages: [message] }, ctx);
  assert.equal(entries.length, 2);
  hooks.session_shutdown();
  assert.equal(renderers['user-image-preview'](entries[1], {}, {}), undefined);
});

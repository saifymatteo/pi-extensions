import test from 'node:test';
import assert from 'node:assert/strict';
import * as nativeTui from '@earendil-works/pi-tui';
import { setImmediate } from 'node:timers/promises';
import { loadExtension } from '../../../test/load-extension.mjs';
import { markdownHost } from './ui-theme.mjs';

const { SessionTrashDialog } = loadExtension(new URL('../src/dialog.ts', import.meta.url), {
  '@earendil-works/pi-tui': nativeTui,
  '@earendil-works/pi-coding-agent': markdownHost,
});
const choice = (value, search = value) => ({ value, label: value, search, description: 'fixture session' });
const preview = name => ({ name, cwd: '/fixture/project', firstRequest: 'First user request', recent: [{ role: 'user', text: 'A recent question' }, { role: 'assistant', text: 'A recent answer' }], truncated: false });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(choices = [choice('a'), choice('b')], query = '', loadPreview = async () => preview('Preview title')) {
  let renders = 0;
  const done = [];
  const tui = { terminal: { rows: 24 }, requestRender: () => { renders++; } };
  const keys = { 'tui.select.cancel': '\x1b', 'tui.select.confirm': '\r', 'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B', 'tui.select.pageUp': '\x1b[5~', 'tui.select.pageDown': '\x1b[6~' };
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
  const dialog = new SessionTrashDialog(tui, theme, { matches: (data, name) => keys[name] === data }, choices, query, value => done.push(value), loadPreview);
  return { dialog, tui, theme, done, get renders() { return renders; }, text: () => dialog.render(110).join('\n') };
}

test('real Pi keybindings page through both search results and preview content', async () => {
  const f = fixture(Array.from({ length: 40 }, (_, index) => choice(`family-${index}`)), '', async () => ({ ...preview('Paged preview'), firstRequest: Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n\n') }));
  f.dialog.keybindings = new nativeTui.KeybindingsManager(nativeTui.TUI_KEYBINDINGS);
  f.text();
  f.dialog.handleInput('\x1b[6~');
  assert.equal(f.dialog.getSelectedItem().value, `family-${f.dialog.viewport}`);
  f.dialog.handleInput('\x1b[5~');
  assert.equal(f.dialog.getSelectedItem().value, 'family-0');
  f.dialog.handleInput('\r'); await setImmediate();
  f.text();
  f.dialog.handleInput('\x1b[6~');
  assert.equal(f.dialog.previewScroll.scrollTop, f.dialog.previewScroll.viewportHeight);
  f.dialog.handleInput('\x1b[5~');
  assert.equal(f.dialog.previewScroll.scrollTop, 0);
  await f.dialog.drain();
});

test('Home and End jump to the first and last family and scroll the preview bounds', async () => {
  const f = fixture(Array.from({ length: 40 }, (_, index) => choice(`family-${index}`)), '', async () => ({ ...preview('Bounded preview'), firstRequest: Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n\n') }));
  f.text();
  f.dialog.handleInput('\x1b[F');
  assert.equal(f.dialog.getSelectedItem().value, 'family-39');
  f.dialog.handleInput('\x1b[H');
  assert.equal(f.dialog.getSelectedItem().value, 'family-0');
  f.dialog.handleInput('\r'); await setImmediate();
  f.text();
  f.dialog.handleInput('\x1b[F');
  const bottom = f.dialog.previewScroll.scrollTop;
  assert.ok(bottom > 0, 'End scrolls the preview to its bottom');
  f.dialog.handleInput('\x1b[H');
  assert.equal(f.dialog.previewScroll.scrollTop, 0);
  await f.dialog.drain();
});

test('families group under their project folder headers in session-search style', () => {
  const f = fixture([
    { ...choice('newest', 'alpha'), group: '--D--Git-IQZ-Monorepo--', cwd: 'D:\\Git\\IQZ-Monorepo' },
    { ...choice('second', 'beta'), group: '--D--Git-IQZ-Monorepo--' },
    { ...choice('other', 'gamma'), group: '--C--Users-Matteo--', cwd: 'C:\\Users\\Matteo' },
  ]);
  const lines = f.text().split('\n');
  assert.ok(lines.some(line => line.includes('▸ D:\\Git\\IQZ-Monorepo')), 'folder label uses the cached cwd');
  assert.ok(lines.some(line => line.includes('▸ C:\\Users\\Matteo')));
  assert.ok(lines.some(line => line.includes('▶ newest')), 'newest family selected first');
  assert.ok(lines.some(line => /\s{5,}second/.test(line)), 'other families render with finder root indent');
  f.dialog.handleInput('\x1b[B');
  assert.equal(f.dialog.getSelectedItem().value, 'second');
  f.dialog.handleInput('\x1b[B'); // Down crosses the folder header into the next group.
  assert.equal(f.dialog.getSelectedItem().value, 'other');
  const scrolled = f.text();
  assert.ok(scrolled.includes('▸ C:\\Users\\Matteo'), 'reaching another group shows its header');
  f.dialog.handleInput('\x1b[F'); // End lands on the last family across groups.
  assert.equal(f.dialog.getSelectedItem().value, 'other');
  f.dialog.handleInput('\x1b[H'); // Home returns to the newest family.
  assert.equal(f.dialog.getSelectedItem().value, 'newest');
});

test('families sharing a project never split even when only some have a cached cwd', () => {
  const f = fixture([
    { ...choice('warm1'), group: '--D--Git-IQZ-Monorepo--', cwd: 'D:\\Git\\IQZ-Monorepo' },
    { ...choice('cold1'), group: '--D--Git-IQZ-Monorepo--' },
    { ...choice('warm2'), group: '--D--Git-IQZ-Monorepo--', cwd: 'D:\\Git\\IQZ-Monorepo' },
    { ...choice('cold2'), group: '--D--Git-IQZ-Monorepo--' },
    { ...choice('other'), group: '--C--Users-Matteo--', cwd: 'C:\\Users\\Matteo' },
  ]);
  const lines = f.text().split('\n');
  assert.equal(lines.filter(line => line.includes('IQZ-Monorepo')).length, 1, 'one header for the whole project');
  assert.ok(lines.some(line => line.includes('▸ D:\\Git\\IQZ-Monorepo')), 'label prefers the cached cwd');
  assert.doesNotMatch(f.text(), /--D--Git-IQZ-Monorepo--/, 'raw encoded segment never leaks as a label');
});

test('the fixed folder header follows the top of the scrolling window like session search', () => {
  const choices = Array.from({ length: 20 }, (_, index) => ({ ...choice(`a${index}`), group: '--D--Git-ProjectX--', cwd: index === 0 ? 'D:\\Git\\ProjectX' : undefined }));
  choices.push(...[
    { ...choice('b0'), group: '--D--Git-ProjectY--' },
    { ...choice('c0'), group: '--C--Users-Matteo--', cwd: 'C:\\Users\\Matteo' },
  ]);
  const f = fixture(choices);
  f.dialog.handleInput('\x1b[F'); // End selects c0, scrolling deep into group X.
  const lines = f.text().split('\n');
  assert.equal(f.dialog.getSelectedItem().value, 'c0');
  assert.ok(lines.some(line => line.includes('▸ D:\\Git\\ProjectX')), 'fixed header names the group at the window top');
  assert.ok(lines.some(line => line.includes('▸ C:\\Users\\Matteo')), "the selected family's own header shows inline");
  const fixedIndex = lines.findIndex(line => line.includes('▸ D:\\Git\\ProjectX'));
  const inlineCIndex = lines.findIndex(line => line.includes('▸ C:\\Users\\Matteo'));
  assert.ok(fixedIndex < inlineCIndex, 'fixed header precedes the selected group header');
});

test('query filtering keeps only matching folders and preserves selection', () => {
  const f = fixture([
    { ...choice('a', 'needle one'), group: 'g1', cwd: '/one' },
    { ...choice('b', 'unrelated'), group: 'g1', cwd: '/one' },
    { ...choice('c', 'other'), group: 'g2', cwd: '/two' },
  ]);
  f.text();
  f.dialog.handleInput('needle');
  const lines = f.text();
  assert.ok(lines.includes('▸ /one'), 'folder with matches stays');
  assert.doesNotMatch(lines, /g2|\/two/);
  assert.ok(lines.includes('▶ '));
  for (let i = 0; i < 6; i++) f.dialog.handleInput('\x7f'); // Backspace clears the query.
  assert.ok(f.text().includes('▸ /two'));
});

test('progressive enrichment preserves the query and reveals newly indexed matches', () => {
  const f = fixture([choice('a')], 'needle');
  f.dialog.update([choice('a')], { completed: 0, total: 1, failed: 0 });
  assert.match(f.text(), /No matches yet.*indexing 0\/1/);
  f.dialog.update([{ ...choice('a', 'needle'), label: 'Found the session' }], { completed: 1, total: 1, failed: 0 });
  assert.match(f.text(), /needle/);
  assert.match(f.text(), /Found the session/);
  assert.doesNotMatch(f.text(), /indexing|No matching/);
  f.dialog.handleInput('\x12');
  assert.deepEqual(f.done, ['a']);
});

test('choice updates and resize preserve the selected family by ID rather than label or index', () => {
  const f = fixture();
  f.dialog.render(110);
  f.dialog.handleInput('\x1b[B');
  f.dialog.update([{ ...choice('b'), label: 'new label' }, choice('a')], { completed: 1, total: 2, failed: 0 });
  f.tui.terminal.rows = 12;
  f.dialog.render(70);
  f.dialog.handleInput('\x12');
  assert.deepEqual(f.done, ['b']);
});

test('metadata failures remain visible when search cannot match any loaded text', () => {
  const f = fixture([choice('a')], 'unknown');
  f.dialog.update([choice('a')], { completed: 1, total: 1, failed: 1 });
  assert.match(f.text(), /search incomplete/);
  assert.match(f.text(), /1 unavailable/);
  assert.doesNotMatch(f.text(), /Trash empty/);
});

test('progress updates render within narrow widths and short terminal heights', () => {
  for (const width of [1, 8, 15, 16, 24, 80]) {
    for (const height of [1, 3, 7, 8, 25]) {
      const f = fixture([choice('界🙂'.repeat(30))]);
      f.dialog.update([choice('界🙂'.repeat(30))], { completed: 0, total: 1, failed: 0 });
      f.tui.terminal.rows = height;
      const lines = f.dialog.render(width);
      assert.ok(lines.length <= height, `height ${height}: ${lines.length} lines`);
      for (const line of lines) assert.ok(nativeTui.visibleWidth(line) <= width, `width ${width}: ${nativeTui.visibleWidth(line)}`);
    }
  }
});

test('Enter loads a read-only preview on demand; Esc preserves query, selection and input focus', async () => {
  const calls = [];
  const f = fixture([choice('alpha', 'needle'), choice('beta', 'needle')], 'needle', async (...args) => { calls.push(args); return preview('Chosen title'); });
  f.dialog.focused = true;
  f.dialog.render(110);
  assert.equal(calls.length, 0);
  f.dialog.handleInput('\x1b[B');
  f.dialog.handleInput('\r');
  assert.match(f.text(), /Loading preview/);
  assert.deepEqual(f.done, []);
  await setImmediate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'beta');
  assert.match(f.text(), /Chosen title/);
  assert.match(f.text(), /First user request/);
  assert.match(f.text(), /A recent answer/);
  assert.equal(f.text().includes(nativeTui.CURSOR_MARKER), false);
  f.dialog.handleInput('r'); // Only Ctrl+R restores, even in the preview.
  f.dialog.handleInput('\r');
  assert.deepEqual(f.done, []);
  f.dialog.handleInput('\x1b');
  assert.match(f.text(), /needle/);
  assert.ok(f.text().includes(nativeTui.CURSOR_MARKER));
  f.dialog.handleInput('\x12');
  assert.deepEqual(f.done, ['beta']);
  await f.dialog.drain();
});

test('project metadata and excerpt status stay outside scrolling transcript content', async () => {
  const cwd = 'D:\\Git\\IQZ-Monorepo';
  const f = fixture(undefined, '', async () => ({ ...preview('Fixed chrome'), cwd, firstRequest: 'Original request', recent: [{ role: 'assistant', text: Array.from({ length: 60 }, (_, i) => `Transcript line ${i}`).join('\n\n') }], truncated: true }));
  f.theme.fg = (token, text) => token === 'muted' ? `\x1b[90m${text}\x1b[39m` : text;
  f.dialog.handleInput('\r'); await setImmediate();
  const top = f.dialog.render(110);
  const transcript = nativeTui.stripTerminalSequences(f.dialog.previewContent.render(104).join('\n'));
  assert.match(nativeTui.stripTerminalSequences(top[1]), /IQZ-Monorepo.*Session 1\/1.*read-only/);
  assert.ok(top[2].includes(`\x1b[90m${cwd}`), 'path is muted UI metadata');
  assert.doesNotMatch(transcript, /IQZ-Monorepo|Fixed chrome|Preview only|Some content shortened|Excerpt shortened/);
  assert.match(nativeTui.stripTerminalSequences(top.at(-3)), /Preview only.*Some content shortened/);
  assert.match(nativeTui.stripTerminalSequences(top.at(-4)), /^┣━+┫$/);
  for (let i = 0; i < 20; i++) f.dialog.handleInput('\x1b[6~');
  const bottom = f.dialog.render(110);
  assert.deepEqual(bottom.slice(0, 4), top.slice(0, 4), 'project header stays fixed');
  assert.deepEqual(bottom.slice(-4), top.slice(-4), 'notice and controls stay fixed');
  assert.match(nativeTui.stripTerminalSequences(bottom.join('\n')), /Transcript line 59/);
  await f.dialog.drain();
});

test('preview section rules remain distinct from Markdown headings and message text', async () => {
  const f = fixture(undefined, '', async () => ({ ...preview('Section rules'), firstRequest: '# A content heading\n\nOriginal request', recent: [{ role: 'assistant', text: '**RECENT MESSAGES**\n\nAn answer' }] }));
  f.tui.terminal.rows = 40;
  f.dialog.handleInput('\r'); await setImmediate();
  const lines = nativeTui.stripTerminalSequences(f.dialog.previewContent.render(64).join('\n')).split('\n');
  assert.ok(lines.includes('── FIRST REQUEST ' + '─'.repeat(47)));
  assert.ok(lines.includes('── RECENT MESSAGES ' + '─'.repeat(45)));
  assert.ok(lines.some(line => line.startsWith('│  ') && line.includes('A content heading')));
  assert.ok(lines.some(line => line.startsWith('│  ') && line.includes('RECENT MESSAGES')));
  assert.ok(lines.some(line => line.trim() === 'You'));
  assert.ok(lines.some(line => line.trim() === 'Assistant'));
  await f.dialog.drain();
});

test('long Windows and POSIX paths retain their meaningful suffix without Markdown formatting', async () => {
  for (const cwd of ['D:\\' + 'parent\\'.repeat(12) + 'IQZ-Monorepo', '/' + 'parent/'.repeat(12) + 'repo_界🙂']) {
    const f = fixture(undefined, '', async () => ({ ...preview('Path preview'), cwd }));
    f.tui.terminal.rows = 30;
    f.dialog.handleInput('\r'); await setImmediate();
    const lines = f.dialog.render(60);
    const path = nativeTui.stripTerminalSequences(lines[2]).replace(/^┃  |  ┃$/g, '').trimEnd();
    assert.ok(path.startsWith('…'), 'truncate from the left, not the project suffix');
    assert.ok(path.endsWith(cwd.includes('\\') ? 'IQZ-Monorepo' : 'repo_界🙂'));
    assert.ok(nativeTui.visibleWidth(path) <= 54);
    assert.match(nativeTui.stripTerminalSequences(lines[1]), /IQZ-Monorepo|repo_界🙂/);
    await f.dialog.drain();
  }
});

test('fixed metadata collapses line breaks without changing multiline message bodies', async () => {
  const f = fixture(undefined, '', async () => ({ ...preview('Session\nname'), cwd: '/fixture/project\npath', firstRequest: 'First paragraph\n\nSecond paragraph' }));
  f.dialog.handleInput('\r'); await setImmediate();
  const lines = f.dialog.render(110);
  assert.ok(lines.every(line => !/[\r\n]/.test(line)), 'each rendered row stays a single terminal line');
  const text = nativeTui.stripTerminalSequences(lines.join('\n'));
  assert.match(text, /Session name/);
  assert.match(text, /\/fixture\/project path/);
  const body = nativeTui.stripTerminalSequences(f.dialog.previewContent.render(104).join('\n'));
  assert.match(body.split('\n').map(line => line.trimEnd()).join('\n'), /│  First paragraph\n│\n│  Second paragraph/);
  await f.dialog.drain();
});

test('missing project and user text keep explicit fallback labels in their separate regions', async () => {
  const f = fixture(undefined, '', async () => ({ ...preview('Empty metadata'), cwd: '', firstRequest: '', recent: [] }));
  f.dialog.handleInput('\r'); await setImmediate();
  const lines = f.dialog.render(110).map(nativeTui.stripTerminalSequences);
  assert.match(lines[1], /Project not recorded/);
  const body = nativeTui.stripTerminalSequences(f.dialog.previewContent.render(104).join('\n'));
  assert.doesNotMatch(body, /Project not recorded/);
  assert.match(body, /│  No user text recorded/);
  await f.dialog.drain();
});

test('plain lowercase and uppercase R remain searchable; Ctrl+R requests restore', () => {
  const f = fixture([choice('a', 'rR')]);
  f.dialog.handleInput('rR');
  assert.deepEqual(f.done, []);
  assert.match(f.text(), /rR/);
  f.dialog.handleInput('\x12');
  assert.deepEqual(f.done, ['a']);
});

test('member switching cancels old loads and ignores late responses', async () => {
  const pending = [];
  const f = fixture([{ ...choice('a'), members: 2 }], '', (_id, member, signal) => {
    const gate = deferred(); pending.push({ member, signal, ...gate }); return gate.promise;
  });
  f.dialog.handleInput('\r');
  await setImmediate();
  f.dialog.handleInput(']');
  await setImmediate();
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(pending.map(p => p.member), [0, 1]);
  pending[1].resolve(preview('second member'));
  await setImmediate();
  assert.match(f.text(), /Session 2\/2/);
  assert.match(f.text(), /second member/);
  pending[0].resolve(preview('stale first member'));
  await setImmediate();
  assert.doesNotMatch(f.text(), /stale first member/);
  f.dialog.handleInput('\x1b');
  await f.dialog.drain();
});

test('switching members clears old fixed metadata and truncation status while loading or failing', async () => {
  const gate = deferred();
  const f = fixture([{ ...choice('a'), members: 2 }], '', async (_id, member) => {
    if (member === 0) return { ...preview('Previous member'), cwd: 'D:\\old-project', truncated: true };
    await gate.promise;
    throw new Error('Changed source');
  });
  f.dialog.handleInput('\r'); await setImmediate();
  assert.match(f.text(), /Previous member/);
  assert.match(f.text(), /Some content shortened/);
  f.dialog.handleInput(']'); await setImmediate();
  assert.match(f.text(), /Loading preview/);
  assert.match(f.text(), /Session 2\/2/);
  assert.doesNotMatch(f.text(), /Previous member|old-project|Some content shortened/);
  gate.resolve(); await setImmediate();
  assert.match(f.text(), /Preview unavailable.*Changed source/);
  assert.doesNotMatch(f.text(), /Previous member|old-project|Some content shortened/);
  await f.dialog.drain();
});

test('restore aborts and drains every preview task, including a superseded member load', async () => {
  const pending = [];
  const f = fixture([{ ...choice('a'), members: 2 }], '', (_id, member, signal) => {
    const gate = deferred(); pending.push({ member, signal, ...gate }); return gate.promise;
  });
  f.dialog.handleInput('\r'); await setImmediate();
  f.dialog.handleInput(']'); await setImmediate();
  f.dialog.handleInput('\x12');
  assert.deepEqual(f.done, ['a']);
  assert.ok(pending.every(p => p.signal.aborted));
  let drained = false;
  const draining = f.dialog.drain().then(() => { drained = true; });
  pending[1].resolve(preview('second')); await setImmediate();
  assert.equal(drained, false);
  const renders = f.renders;
  pending[0].resolve(preview('first')); await draining;
  assert.equal(drained, true);
  assert.equal(f.renders, renders);
});

test('preview errors remain read-only and do not prevent an explicit restore request', async () => {
  const f = fixture(undefined, '', async () => { throw new Error('source changed: **literal**'); });
  f.dialog.handleInput('\r'); await setImmediate();
  assert.match(f.text(), /Preview unavailable.*source changed/);
  assert.match(f.text(), /\*\*literal\*\*/);
  assert.doesNotMatch(f.text(), /\x1b\[1mliteral/);
  assert.deepEqual(f.done, []);
  f.dialog.handleInput('\x12');
  assert.deepEqual(f.done, ['a']);
  await f.dialog.drain();
});

test('preview wrapping and scrolling fit short/narrow terminals and resize safely', async () => {
  const f = fixture(undefined, '', async () => ({ ...preview('Wide 界🙂'), firstRequest: '# Wide heading\n\n| Key | Value |\n|---|---|\n| 界 | 🙂 |\n\n```ts\n' + '界🙂'.repeat(2000) + '\n```', truncated: true }));
  f.dialog.handleInput('\r'); await setImmediate();
  for (const width of [1, 8, 15, 16, 24, 80]) {
    for (const height of [1, 3, 7, 8, 25]) {
      f.tui.terminal.rows = height;
      const lines = f.dialog.render(width);
      assert.ok(lines.length <= height);
      for (const line of lines) assert.ok(nativeTui.visibleWidth(line) <= width, `width ${width}: ${nativeTui.visibleWidth(line)}`);
      f.dialog.handleInput('\x1b[6~');
      f.dialog.handleInput('\x1b[5~');
    }
  }
  await f.dialog.drain();
});

test('preview uses native Markdown styling while names and paths stay literal', async () => {
  const f = fixture(undefined, '', async () => ({
    ...preview('Session **literal**'), cwd: '/fixture/_literal_',
    firstRequest: '**Bold request** with _emphasis_\n\n> A quote\n\n- An item\n\n```ts\nconst answer = 42;\n```',
  }));
  f.tui.terminal.rows = 80;
  f.dialog.handleInput('\r'); await setImmediate();
  const raw = f.text(), text = nativeTui.stripTerminalSequences(raw);
  assert.match(text, /Session \*\*literal\*\*/);
  assert.match(text, /\/fixture\/_literal_/);
  assert.match(text, /Bold request with emphasis/);
  assert.doesNotMatch(text, /\*\*Bold request\*\*|_emphasis_/);
  assert.match(raw, /\x1b\[1mBold request/);
  assert.match(raw, /\x1b\[3memphasis/);
  assert.match(raw, /\x1b\[32mconst answer = 42/);
  assert.deepEqual(f.done, []);
  await f.dialog.drain();
});

test('every preview body has a rail through wrapped prose and code without a user background', async () => {
  const bodies = ['First request', 'User question', 'Assistant answer'].map(label => `${label}: ${'wrapped words '.repeat(12)}\n\n\`\`\`ts\nconst wrapped = "${'long code '.repeat(8)}";\n\`\`\``);
  const f = fixture(undefined, '', async () => ({
    ...preview('Indented preview'), firstRequest: bodies[0],
    recent: [{ role: 'user', text: bodies[1] }, { role: 'assistant', text: bodies[2] }],
  }));
  let backgrounds = 0;
  f.theme.bg = (_token, text) => { backgrounds++; return `\x1b[44m${text}\x1b[49m`; };
  f.dialog.handleInput('\r'); await setImmediate();
  for (const source of bodies) {
    const rail = f.dialog.previewContent.children.find(child => child.children?.some(body => body instanceof nativeTui.Markdown && body.text === source));
    assert.ok(rail, 'each message retains its own native Markdown renderer');
    const lines = rail.render(36);
    const expected = new nativeTui.Markdown(source, 0, 0, markdownHost.getMarkdownTheme()).render(33).map(line => `│  ${line}`);
    assert.deepEqual(lines, expected);
    const plain = lines.map(nativeTui.stripTerminalSequences);
    assert.ok(plain.length > 8, 'prose and code wrap over multiple lines');
    assert.ok(plain.every(line => line.startsWith('│  ')), 'continuations, blank lines and code fences share the body rail');
    assert.ok(lines.every(line => nativeTui.visibleWidth(line) <= 36));
    assert.doesNotMatch(lines.join('\n'), /\x1b\[(?:4[0-9]|10[0-7]|48)(?:;|m)/);
  }
  assert.equal(backgrounds, 0);
  await f.dialog.drain();
});

test('role headers use bold native blue-link and yellow-warning colors and refresh on invalidation', async () => {
  const f = fixture();
  let colors = { mdLink: 34, warning: 33 };
  f.theme.fg = (token, text) => colors[token] ? `\x1b[${colors[token]}m${text}\x1b[39m` : text;
  f.tui.terminal.rows = 80;
  f.dialog.handleInput('\r'); await setImmediate();
  const checkHeaders = () => {
    const lines = f.dialog.render(110);
    for (const [role, token] of [['You', 'mdLink'], ['Assistant', 'warning']]) {
      const line = lines.find(line => nativeTui.stripTerminalSequences(line).replace(/^┃  |  ┃$/g, '').trimEnd() === role);
      assert.ok(line, `${role} header is visible and unindented`);
      assert.ok(line.includes(f.theme.fg(token, markdownHost.getMarkdownTheme().bold(role))));
    }
  };
  checkHeaders();
  colors = { mdLink: 36, warning: 35 };
  f.dialog.invalidate();
  checkHeaders();
  await f.dialog.drain();
});

test('a clipped code fence cannot consume another message or the truncation notice', async () => {
  const f = fixture(undefined, '', async () => ({
    ...preview('Clipped fence'), firstRequest: '```ts\nconst clipped = 1;',
    recent: [{ role: 'assistant', text: '**Standalone answer** with _details_.' }], truncated: true,
  }));
  f.tui.terminal.rows = 80;
  f.dialog.handleInput('\r'); await setImmediate();
  const lines = f.dialog.render(110);
  const answer = lines.find(line => nativeTui.stripTerminalSequences(line).includes('Standalone answer'));
  assert.ok(answer);
  assert.match(answer, /\x1b\[1mStandalone answer/);
  assert.doesNotMatch(answer, /\x1b\[32m/);
  const notice = lines.find(line => line.includes('Some content shortened'));
  assert.ok(notice);
  assert.doesNotMatch(notice, /\x1b\[32m/);
  await f.dialog.drain();
});

test('scroll and indexing reuse Markdown caches; invalidation refreshes native theme tokens without rereading or losing the offset', async t => {
  let reads = 0, headingColor = 31;
  const original = markdownHost.getMarkdownTheme;
  t.after(() => { markdownHost.getMarkdownTheme = original; });
  markdownHost.getMarkdownTheme = () => {
    const color = headingColor;
    return { ...original(), heading: text => `\x1b[${color}m${text}\x1b[39m` };
  };
  const request = '# Theme heading\n\nA **bold** prompt\n\n' + Array.from({ length: 30 }, (_, i) => `- Item ${i}`).join('\n');
  const f = fixture(undefined, '', async () => { reads++; return { ...preview('Theme change'), firstRequest: request }; });
  f.dialog.handleInput('\r'); await setImmediate();
  assert.match(f.text(), /\x1b\[31m/);
  const rail = f.dialog.previewContent.children.find(child => child.children?.some(body => body instanceof nativeTui.Markdown && body.text === request));
  assert.ok(rail);
  const body = rail.children[0];
  const cached = body.render(101);
  f.dialog.handleInput('\x1b[B');
  f.text();
  f.dialog.update([choice('a'), choice('b')], { completed: 1, total: 2, failed: 0 });
  f.text();
  assert.ok(f.dialog.previewContent.children.includes(rail));
  assert.equal(body.render(101), cached);
  const offset = f.dialog.previewScroll.scrollTop;
  assert.ok(offset > 0);
  headingColor = 34;
  f.dialog.invalidate();
  const restyled = f.text();
  assert.match(restyled, /\x1b\[34m/);
  assert.doesNotMatch(restyled, /\x1b\[31m/);
  assert.match(nativeTui.stripTerminalSequences(restyled), /Theme heading/);
  assert.equal(f.dialog.previewScroll.scrollTop, offset);
  f.tui.terminal.rows = 12;
  f.dialog.render(70);
  assert.equal(f.dialog.previewScroll.scrollTop, offset);
  assert.equal(reads, 1);
  await f.dialog.drain();
});

test('close or disposal suppresses later updates and repeated completion', () => {
  for (const dispose of [false, true]) {
    const f = fixture();
    if (dispose) f.dialog.dispose();
    else f.dialog.handleInput('\x1b');
    const renders = f.renders;
    f.dialog.update([choice('new')], { completed: 1, total: 1, failed: 0 });
    f.dialog.handleInput('\r');
    assert.equal(f.renders, renders);
    assert.deepEqual(f.done, dispose ? [] : [undefined]);
  }
});

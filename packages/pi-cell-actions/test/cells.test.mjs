import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension } from '../../../test/load-extension.mjs';

const cells = loadExtension(new URL('../src/cells.ts', import.meta.url));
// Values from the VM realm have foreign prototypes; compare their JSON shape.
const plain = value => JSON.parse(JSON.stringify(value));

const reply = [
  'Here is a demo.',
  '',
  '```bash',
  'echo "hello" && ls',
  '```',
  '',
  '| Planet | Notes, quirks |',
  '|---|:--|',
  '| Earth | Only known life, liquid water |',
  '| Mars | Red \\| dusty |',
  '',
  '- item',
  '  ```python',
  '  for i in range(3):',
  '      print(i)',
  '  ```',
].join('\n');

test('parses fenced code (nested too) and GFM tables in order', () => {
  const blocks = cells.parseBlocks(reply).filter(b => b.kind !== 'text');
  assert.deepEqual(plain(blocks.map(b => b.kind)), ['code', 'table', 'code']);
  assert.deepEqual(plain(blocks[0]), { kind: 'code', lang: 'bash', code: 'echo "hello" && ls' });
  assert.deepEqual(plain(blocks[1].rows), [['Planet', 'Notes, quirks'], ['Earth', 'Only known life, liquid water'], ['Mars', 'Red | dusty']]);
  assert.equal(blocks[2].code, 'for i in range(3):\n    print(i)');
});

test('text between code and tables splits into paragraphs, headings and lists', () => {
  const md = '## Result\nIt **works**.\nSecond line.\n\n- one\n- [two](https://x.y)\n\n```sh\nls\n```\nAfter.';
  const blocks = cells.parseBlocks(md);
  assert.deepEqual(plain(blocks.map(b => b.kind === 'text' ? b.markdown : b.kind)),
    ['## Result', 'It **works**.\nSecond line.', '- one\n- [two](https://x.y)', 'code', 'After.']);
  const rows = [' Result', ' It works. Second', ' line.', '', ' • one', ' • two', '', ' ```sh', '   ls', ' ```', ' After.', ''];
  assert.deepEqual(plain(cells.locateBlocks(rows, blocks).map(b => [b.kind, b.top, b.bottom])),
    [['text', 0, 0], ['text', 1, 3], ['text', 4, 6], ['code', 7, 9], ['text', 10, 11]]);
});

test('a heading over a letterless first line still splits (pasted tool JSON)', () => {
  const md = '# bash\n{\n  "command": "ls"\n}';
  const blocks = cells.parseBlocks(md);
  assert.deepEqual(plain(blocks.map(b => b.markdown)), ['# bash', '{\n  "command": "ls"\n}']);
  const rows = [' bash', ' {', '   "command": "ls"', ' }'];
  assert.deepEqual(plain(cells.locateBlocks(rows, blocks).map(b => [b.top, b.bottom])), [[0, 0], [1, 3]]);
});

test('TSV and CSV conversions quote only where needed', () => {
  const rows = [['Planet', 'Notes, quirks'], ['Mars', 'say "hi"']];
  assert.equal(cells.toTsv(rows), 'Planet\tNotes, quirks\nMars\tsay "hi"');
  assert.equal(cells.toCsv(rows), 'Planet,"Notes, quirks"\nMars,"say ""hi"""');
});

test('locates blocks in stock, bordered and gutter renderings', () => {
  const blocks = cells.parseBlocks(reply).filter(b => b.kind !== 'text');
  const stock = [
    ' Here is a demo.', '',
    ' ```bash', '   echo "hello" && ls', ' ```', '',
    ' ┌────────┬───────┐', ' │ Planet │ Notes │', ' ├────────┼───────┤', ' │ Earth  │ Only  │', ' │ Mars   │ Red   │', ' └────────┴───────┘', '',
    ' • item', '   ```python', '     for i in range(3):', '         print(i)', '   ```',
  ];
  assert.deepEqual(plain(cells.locateBlocks(stock, blocks).map(b => [b.kind, b.top, b.bottom])), [['code', 2, 4], ['table', 6, 11], ['code', 14, 17]]);
  // pi-codeblock-borders: rules instead of fences, optional line-number gutter.
  const bordered = [' Here is a demo.', '', ' bash──────────', ' 1 │ echo "hello" && ls', ' ──────────────'];
  assert.deepEqual(plain(cells.locateBlocks(bordered, blocks.slice(0, 1)).map(b => [b.top, b.bottom])), [[2, 4]]);
  // A block the renderer did not draw (e.g. still streaming) is skipped.
  assert.deepEqual(plain(cells.locateBlocks([' Here is a demo.'], blocks)), []);
  // With text blocks, the intro paragraph ends where the code starts.
  assert.deepEqual(plain(cells.locateBlocks(stock, cells.parseBlocks(reply)).slice(0, 2).map(b => [b.kind, b.top, b.bottom])), [['text', 0, 1], ['code', 2, 4]]);
});

test('only shell languages are runnable', () => {
  assert.equal(cells.RUNNABLE.bash, 'bash');
  assert.equal(cells.RUNNABLE.python, undefined);
});

test('menu copies a hovered table as CSV through a stubbed fullscreen host', async () => {
  const copied = [];
  class Base { handleMouse() { return undefined; } }
  class UserMessageComponent extends Base {}
  class AssistantMessageComponent extends Base {}
  class ToolExecutionComponent extends Base {}
  const VIEWPORT = Symbol('viewport');
  const extension = loadExtension(new URL('../src/index.ts', import.meta.url), {
    '@earendil-works/pi-coding-agent': { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, copyToClipboard: async t => { copied.push(t); } },
    '@earendil-works/pi-tui': {
      isViewportTUI: t => t?.[VIEWPORT] === true,
      matchesKey: (d, k) => k === 'escape' && d === '\x1b',
      stripTerminalSequences: s => s.replace(/\x1b\[[0-9;]*m/g, ''),
      Text: class { constructor(text) { this.text = text; } },
      truncateToWidth: s => s,
      visibleWidth: s => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length,
    },
    './cells.ts': cells,
  });
  const hooks = {};
  let overlay, overlayOptions, widget, keys;
  const overlays = [];
  // Like Pi, the host dispatches each raw event to the component under the pointer.
  let dispatch = () => {};
  const proto = { handleMouseEvent(raw) { dispatch(raw); } };
  const tui = Object.assign(Object.create(proto), {
    [VIEWPORT]: true,
    renders: 0,
    requestRender() { this.renders++; },
    showOverlay(component, options) { overlays.push([component, options]); overlay = component; overlayOptions = options; return { hide() {}, getBounds: () => undefined }; },
  });
  extension.default({
    on: (name, fn) => { hooks[name] = fn; },
    registerMessageRenderer() {},
    exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
    sendMessage() {},
  });
  hooks.session_start({}, { mode: 'tui', cwd: '/tmp', sessionManager: { getBranch: () => [] }, ui: { setWidget: (_k, f) => { widget = f; }, notify() {}, onTerminalInput: f => { keys = f; return () => { keys = undefined; }; } } });
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: s => s, inverse: s => `\x1b[7m${s}\x1b[27m` };
  widget(tui, theme);

  const table = '| Planet | Notes, quirks |\n|---|---|\n| Mars | Red, dusty |';
  const message = new AssistantMessageComponent();
  message.lastMessage = { content: [{ type: 'text', text: table }] };
  message.render = () => [' ┌──┐', ' │ Planet │', ' ├──┤', ' │ Mars │', ' └──┘'];
  dispatch = raw => raw.y >= 10 && raw.y < 15 && message.handleMouse({ type: 'move', button: 'none', x: raw.x, y: raw.y - 10, screenX: raw.x, screenY: raw.y, width: 80, height: 5 });
  tui.handleMouseEvent({ button: 35, x: 3, y: 11, release: false });

  assert.equal(overlayOptions.nonCapturing, true);
  assert.equal(overlayOptions.visible(), true);
  assert.equal(overlay.render(3)[0], '\x1b[7m ⋯ \x1b[27m');
  assert.equal(overlayOptions.row, 10);
  // Hovering the badge opens the menu; no click needed.
  overlay.handleMouse({ type: 'move', button: 'none', x: 0, y: 0 });
  const [buttons, label] = overlay.render(80);
  assert.match(buttons, /copy markdown.*copy TSV.*copy CSV.*esc/);
  assert.match(label, /table cell/);
  const csvAt = buttons.replace(/\x1b\[[0-9;]*m/g, '').indexOf(' copy CSV ');
  // Hovering a button drops its box (inverse); the others keep theirs.
  overlay.handleMouse({ type: 'move', button: 'none', x: csvAt + 1, y: 0 });
  assert.match(overlay.render(80)[0], /\x1b\[7m copy TSV \x1b\[27m  copy CSV  esc/);
  overlay.handleMouse({ type: 'click', button: 'left', x: csvAt + 1, y: 0 });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(plain(copied), ['Planet,"Notes, quirks"\nMars,"Red, dusty"']);
  assert.match(overlay.render(80)[0], /✓ copied/);

  // A mouse event between render and click (place() runs after each) must not move the buttons.
  const para = new AssistantMessageComponent();
  para.lastMessage = { content: [{ type: 'text', text: 'Hello there.' }] };
  para.render = () => [' Hello there.'];
  dispatch = raw => raw.y === 20 && para.handleMouse({ type: 'move', button: 'none', x: raw.x, y: 0, screenX: raw.x, screenY: raw.y, width: 80, height: 1 });
  tui.handleMouseEvent({ button: 35, x: 3, y: 20, release: false });
  overlay.handleMouse({ type: 'click', button: 'left', x: 0, y: 0 });
  const [row] = overlay.render(overlayOptions.width);
  tui.handleMouseEvent({ button: 35, x: 4, y: 20, release: false });
  overlay.handleMouse({ type: 'click', button: 'left', x: row.replace(/\x1b\[[0-9;]*m/g, '').indexOf('copy') + 3, y: 0 }); // the 'y'
  await new Promise(r => setImmediate(r));
  assert.equal(copied.at(-1), 'Hello there.');

  // The Esc key closes an open menu and is consumed; closed, it passes through.
  overlay.handleMouse({ type: 'click', button: 'left', x: 0, y: 0 });
  assert.deepEqual(plain(keys('\x1b')), { consume: true });
  assert.match(overlay.render(overlayOptions.width)[0], /⋯/);
  assert.equal(keys('\x1b'), undefined);

  // Moving off every cell hides the badge; shutdown restores the prototypes.
  tui.handleMouseEvent({ button: 35, x: 3, y: 40, release: false });
  assert.equal(overlayOptions.visible(), false);
  hooks.session_shutdown();
  assert.equal(Object.hasOwn(AssistantMessageComponent.prototype, 'handleMouse'), false);
  assert.equal(Object.hasOwn(tui, 'handleMouseEvent'), false);
});

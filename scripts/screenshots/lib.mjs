// Screenshot harness: drives the stock Pi host in a PTY against a scripted
// local OpenAI-compatible provider, then snapshots the xterm buffer as cells.
import http from 'node:http';
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import xterm from '@xterm/headless';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const pkg = name => join(ROOT, 'packages', name);
const STOCK = join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- scripted provider ------------------------------------------------------
// turns[i] answers the i-th model request of the session. A turn is
// { text?, thinking?, tools?: [{ name, args }] }, or a function(request) => turn.
export async function startProvider(turns = [], routes = {}) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let request = {};
      try { request = JSON.parse(body); } catch {}
      const route = Object.entries(routes).find(([k]) => req.url.includes(k));
      if (route) return route[1](req, res, request, body);
      if (request.stream !== true && routes.nonstream) return routes.nonstream(req, res, request);
      let turn = typeof turns === 'function' ? turns(request, n++) : turns[n++] ?? { text: 'Done.' };
      if (typeof turn === 'function') turn = turn(request);
      if (turn.delay) await sleep(turn.delay);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = delta => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'demo', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (turn.thinking) send({ role: 'assistant', reasoning_content: turn.thinking });
      if (turn.text) for (const piece of turn.text.match(/[\s\S]{1,40}/g)) send({ role: 'assistant', content: piece });
      (turn.tools ?? []).forEach((t, index) => send({ role: 'assistant', tool_calls: [{ index, id: `call_${n}_${index}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] }));
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'demo', choices: [{ index: 0, delta: {}, finish_reason: turn.tools?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3120, completion_tokens: 86, total_tokens: 3206 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close(), get calls() { return n; } };
}

export const DEMO_FILES = {
  'acme-api/package.json': '{\n  "name": "acme-api",\n  "scripts": { "test": "node --test" }\n}\n',
  'acme-api/src/server.ts': "import { createServer } from 'node:http';\nimport { router } from './router';\n\n// TODO: read the port from config\nconst PORT = 3000;\n\ncreateServer(router).listen(PORT, () => {\n  console.log(`listening on ${PORT}`);\n});\n",
  'acme-api/src/router.ts': "import type { RequestListener } from 'node:http';\n\n// TODO: add /health\nexport const router: RequestListener = (req, res) => {\n  res.writeHead(404).end();\n};\n",
  'acme-api/README.md': '# acme-api\n\nTiny demo service.\n',
};

// --- isolated home ----------------------------------------------------------
// HOME is a temp dir; the agent dir is ~/.pi/agent and the project ~/acme-api,
// so paths render as they would on a real machine. `files` keys are relative to
// HOME; an "agent/" prefix maps to the agent dir.
// HOME is a short fixed path (/tmp/demo) so absolute paths in tool output stay
// readable; sessions run one at a time. `realHome` resolves symlinks (/private/tmp)
// for extensions that reject symlinked path components.
// POSIX keeps /tmp/demo; Windows has no /tmp, so fall back to the OS temp dir.
const DEMO_HOME = process.platform === 'win32' ? join(tmpdir(), 'pi-shots-demo') : '/tmp/demo';
const DEMO_TMP = process.platform === 'win32' ? tmpdir() : '/tmp';
export function makeHome(port, { settings = {}, files = {}, models, setup, realHome = false } = {}) {
  rmSync(DEMO_HOME, { recursive: true, force: true });
  mkdirSync(DEMO_HOME);
  const home = realpathSync(DEMO_HOME); // pi realpaths cwd, so HOME must match
  const agent = join(home, '.pi', 'agent');
  for (const d of ['tmp', join('.pi', 'agent', 'sessions'), join('.pi', 'agent', 'bin'), 'acme-api']) mkdirSync(join(home, d), { recursive: true });
  for (const [rel, content] of Object.entries({ ...DEMO_FILES, ...files })) {
    const p = rel.startsWith('agent/') ? join(agent, rel.slice(6)) : join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  }
  const project = join(home, 'acme-api');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  spawnSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qam', 'init', '--allow-empty'], { cwd: project });
  spawnSync('git', ['add', '-A'], { cwd: project });
  spawnSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init'], { cwd: project });
  writeFileSync(join(agent, 'trust.json'), JSON.stringify({ [project]: true, [realpathSync(project)]: true }));
  writeFileSync(join(agent, 'models.json'), JSON.stringify(models ?? {
    providers: { demo: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'demo', models: [{ id: 'demo-model', name: 'demo-model', input: ['text', 'image'], reasoning: false, contextWindow: 200000 }] } },
  }, null, 2));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'demo', defaultModel: 'demo-model', quietStartup: true, ...settings }, null, 2));
  // Stub fd so offline startup doesn't warn about a missing binary.
  writeFileSync(join(agent, 'bin', 'fd'), '#!/bin/sh\necho "fd 10.2.0"\n', { mode: 0o755 });
  setup?.({ home, agent, project, port });
  return { home, agent, project };
}

export function hostEnv({ home, agent }, env = {}) {
  return { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'), TMPDIR: DEMO_TMP, COLORTERM: 'truecolor', TERM: 'xterm-256color', TERM_PROGRAM: 'shots', HOME: home, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_TELEMETRY: '0', ...env };
}
export const hostArgs = (extensions, { session = false, skills = false } = {}) => [STOCK,
  '--no-extensions', ...(skills ? [] : ['--no-skills']), '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-context-files', ...(session ? [] : ['--no-session']), '--no-approve',
  '--tools', '*', ...extensions.flatMap(e => ['-e', e.includes('/') ? e : pkg(e)])];

// --- PTY session ------------------------------------------------------------
export async function session({ extensions = [], cols = 100, rows = 30, turns, routes, settings, files, setup, realHome, args = [], env = {}, cwd, models, keepSession = false, skills = false, dirs }) {
  const provider = await startProvider(turns, routes);
  dirs ??= makeHome(provider.port, { settings, files, models, setup, realHome });
  const { home } = dirs;
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  const p = pty.spawn(process.execPath, [...hostArgs(extensions, { session: keepSession, skills }), ...args], {
    name: 'xterm-256color', cols, rows, cwd: cwd ?? dirs.project, env: hostEnv(dirs, env),
  });
  let title = '';
  term.onTitleChange(t => (title = t));
  // Answer terminal queries the TUI may send (cursor position, device attrs, cell size).
  term.onData(d => p.write(d));
  // Kitty graphics (pi emits them with PI_IMAGE_PROTOCOL=kitty): xterm-headless
  // ignores APC, so track transmissions and where each placement lands.
  const images = new Map(); // id -> base64
  const placements = new Map(); // id -> { row (absolute), col, c, r }
  let pending = '', current = null;
  const onApc = body => {
    const [ctl, data = ''] = body.split(';');
    const kv = Object.fromEntries(ctl.split(',').filter(Boolean).map(x => x.split('=')));
    if (kv.a === 'd') { if (kv.d === 'I' || kv.d === 'i') placements.delete(kv.i); else placements.clear(); return; }
    if (kv.a === 'T' || kv.a === 'p' || (current && !kv.a)) {
      if (kv.a) current = { id: kv.i ?? 'anon', c: +kv.c || 0, r: +kv.r || 0 };
      const cur = current;
      if (kv.a === 'T') images.set(cur.id, '');
      if (data) images.set(cur.id, (images.get(cur.id) ?? '') + data);
      if (kv.a) term.write('', () => { const b = term.buffer.active; placements.set(cur.id, { row: b.baseY + b.cursorY, col: b.cursorX, c: cur.c, r: cur.r }); });
      if (kv.m !== '1' && !kv.a) current = null;
    }
  };
  p.onData(d => {
    let s = pending + d; pending = '';
    for (;;) {
      const i = s.indexOf('\x1b_G');
      if (i < 0) { term.write(s); break; }
      const j = s.indexOf('\x1b\\', i);
      if (j < 0) { term.write(s.slice(0, i)); pending = s.slice(i); break; }
      term.write(s.slice(0, i)); onApc(s.slice(i + 3, j)); s = s.slice(j + 2);
    }
  });
  let exited = false;
  p.onExit(() => (exited = true));
  const api = {
    term, home, dirs, provider, pty: p, get title() { return title; },
    text: () => { const b = term.buffer.active; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? ''); return out.join('\n'); },
    screen: () => { const b = term.buffer.active; const out = []; for (let y = b.viewportY; y < b.viewportY + rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? ''); return out.join('\n'); },
    async waitFor(pattern, timeout = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const s = api.screen();
        if (typeof pattern === 'string' ? s.includes(pattern) : pattern.test(s)) return;
        if (exited) throw new Error('pi exited');
        await sleep(100);
      }
      throw new Error(`timeout waiting for ${pattern}\n---\n${api.screen()}`);
    },
    async type(s, delay = 8) { for (const ch of s) { p.write(ch); await sleep(delay); } },
    key(seq) { p.write(seq); },
    async settle(ms = 600) { await sleep(ms); },
    snapshot: () => {
      const snap = snapshot(term); const top = term.buffer.active.viewportY;
      snap.images = [...placements].filter(([id, pl]) => images.get(id) && pl.row >= top && pl.row < top + rows)
        .map(([id, pl]) => ({ y: pl.row - top, x: pl.col, c: pl.c, r: pl.r, src: `data:image/png;base64,${images.get(id)}` }));
      return snap;
    },
    kill() { try { p.kill(); } catch {} provider.close(); },
  };
  return api;
}

export const KEY = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', ctrlO: '\x0f', ctrlC: '\x03', altV: '\x1bv', altO: '\x1bo', pgdn: '\x1b[6~' };

// --- buffer snapshot --------------------------------------------------------
// Cells: { ch, w, fg, bg, bold, dim, italic, underline, inverse }. Colors are
// '#rrggbb', palette index numbers, or null for default.
function color(cell, which) {
  const isRGB = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const isPal = which === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const v = which === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (isRGB) return '#' + v.toString(16).padStart(6, '0');
  if (isPal) return v;
  return null;
}
export function snapshot(term) {
  const b = term.buffer.active;
  const lines = [];
  for (let y = b.viewportY; y < b.viewportY + term.rows; y++) {
    const line = b.getLine(y);
    const cells = [];
    for (let x = 0; x < term.cols; x++) {
      const c = line?.getCell(x);
      if (!c) { cells.push({ ch: ' ', w: 1 }); continue; }
      if (c.getWidth() === 0) continue;
      cells.push({ ch: c.getChars() || ' ', w: c.getWidth(), fg: color(c, 'fg'), bg: color(c, 'bg'), bold: !!c.isBold(), dim: !!c.isDim(), italic: !!c.isItalic(), underline: !!c.isUnderline(), inverse: !!c.isInverse() });
    }
    lines.push(cells);
  }
  return { cols: term.cols, lines };
}

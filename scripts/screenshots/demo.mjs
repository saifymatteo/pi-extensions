// npm run demo  — record demo.gif at the repo root: one session of the root
// collection package (every extension loaded), driven by a scripted model.
// The screen is sampled every TICK ms; identical samples merge into one frame.
// DRY=1 prints each scene's final screen instead of rendering.
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import omggif from 'omggif';
const { quantize, applyPalette } = gifenc, { GifWriter } = omggif;
import { session, KEY, ROOT, HERE, sleep } from './lib.mjs';
import { page } from './render.mjs';
import { seedStore, CLIP_ENV, KITTY, BUG_PNG, allText, json, ROUTER_MODELS } from './shots.mjs';

const COLS = 100, ROWS = 34, TICK = 100, MAX_HOLD = 3000, END_HOLD = 4000;
const OUT = process.env.OUT ?? join(ROOT, 'demo.gif');

// --- scripted model ---------------------------------------------------------
const MAIN = [
  { tools: [
    { name: 'zvec_search', args: { query: 'where is the HTTP port configured', mode: 'hybrid', limit: 3 } },
    { name: 'codegraph_explore', args: { query: 'createServer router PORT', maxFiles: 2 } },
    { name: 'bash', args: { command: 'npm test --silent', background: true } },
  ] },
  { text: '`PORT = 3000` is hard-coded in `src/server.ts`, which hands `router` to `createServer`. Tests are running in the background.' },
  { text: 'Background tests finished: all 42 passed, 91% coverage.' },
  { text: ['Here is the route:', '', '```ts title="src/router.ts" :line-numbers {4-6}', "import type { RequestListener } from 'node:http';", '', 'export const router: RequestListener = (req, res) => {', "  if (req.url === '/health') {", "    return res.writeHead(200).end('ok');", '  }', '  res.writeHead(404).end();', '};', '```'].join('\n') },
  { tools: [{ name: 'write', args: { path: '~/.pi/agent/settings.json', content: '{ "defaultModel": "gpt-5" }\n' } }] },
  { text: "I can't write to the Pi config root — please change the default model yourself." },
  { text: 'The form shows a **500** from `POST /users`: the `+` in `sam+test@acme.dev` trips the email validator.' },
];
let m = 0;
const turns = req => /starts a new topic/.test(allText(req))
  ? { text: '{"isNewTopic": true, "title": "Port config and health route"}' }
  : MAIN[m++] ?? { text: 'Done.' };

// --- recorder ---------------------------------------------------------------
const frames = []; // { key, snap, title, label, t }
let label = '';
function sample(s) {
  const snap = s.snapshot();
  const key = JSON.stringify([snap.lines, snap.images, s.title, label]);
  if (frames.at(-1)?.key !== key) frames.push({ key, snap, title: s.title, label, t: Date.now() });
}
const scene = (s, name) => { label = name; sample(s); if (process.env.DRY) console.log(`=== ${name}`); };
const dumpScreen = s => process.env.DRY && console.log(s.screen().replace(/\n\s*$/gm, '\n').trimEnd());
async function ask(s, text, until, hold = 1800) {
  await s.type(text, 45); await sleep(400); s.key(KEY.enter);
  await s.waitFor(until, 30000); await sleep(hold); dumpScreen(s);
}

const files = {
  'agent/state/claude-usage.json': { fiveHour: { pct: 42, resetsAt: Date.now() + 133 * 60e3 }, sevenDay: { pct: 78, resetsAt: Date.now() + 76 * 3600e3 }, rejected: false, overage: false },
  'agent/extensions/session-rename.json': { model: { provider: 'claude-code', id: 'demo-model', thinking: 'off' } },
  'acme-api/package.json': JSON.stringify({ name: 'acme-api', scripts: { test: "sleep 5 && echo '✔ 42 tests passed' && echo 'coverage 91%'" } }, null, 2),
};
const s = await session({
  extensions: [ROOT], cols: COLS, rows: ROWS, turns, files, keepSession: true,
  routes: { '/models': (req, res) => json(res, { data: ROUTER_MODELS }) },
  settings: { defaultProvider: 'claude-code' },
  setup: d => {
    seedStore(d);
    // pi-9router: the router (this fake server) lists its models; the key is the /login credential.
    writeFileSync(join(d.agent, 'extensions', '9router.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${d.port}/v1` }));
    writeFileSync(join(d.agent, 'auth.json'), JSON.stringify({ '9router': { type: 'oauth', access: 'demo-key', refresh: 'demo-key', expires: Number.MAX_SAFE_INTEGER } }));
    writeFileSync(join(d.agent, 'models.json'), JSON.stringify({ providers: { 'claude-code': { baseUrl: `http://127.0.0.1:${d.port}/v1`, api: 'openai-completions', apiKey: 'demo', models: [{ id: 'demo-model', name: 'demo-model', input: ['text', 'image'], contextWindow: 200000 }] } } })); },
  env: { ...CLIP_ENV, ...KITTY, HERDR_ENV: '', HERDR_TAB_ID: '', ZVEC_GREP_MODEL_CACHE: `${process.env.HOME}/.zvec-grep/models`, ZVEC_GREP_MODE: 'direct' },
});
try {
  await s.waitFor(/Zvec: (indexed|synced)/, 90000); await s.waitFor(/CodeGraph: synced/, 30000); await s.waitFor('Claude 5h', 10000); await sleep(500);
  const timer = setInterval(() => sample(s), TICK);
  try {
    scene(s, 'Loaded: all 24 extensions from @saifymatteo/pi-extensions'); await sleep(2500);
    scene(s, 'pi-claude-usage · pi-codegraph · pi-zvec  —  footer status'); await sleep(2500);
    scene(s, 'pi-zvec · pi-codegraph · pi-compact-tools · pi-bg-bash · pi-session-rename');
    await ask(s, 'where is the port set? run the tests in the background too', '91% coverage', 2500);
    scene(s, 'pi-codeblock-borders  —  titles, line numbers, highlighted lines');
    await ask(s, 'add a /health route', "res.writeHead(404)", 3000);
    scene(s, 'pi-root-guard  —  the agent cannot rewrite its own config');
    await ask(s, 'make gpt-5 my default model', 'yourself', 2500);
    scene(s, "pi-9router  —  /model lists every model from the router's own /v1/models");
    await s.type('/model', 45); await sleep(300); s.key(KEY.enter); await s.waitFor('oc/jev-1.13-free'); await sleep(800);
    for (let i = 0; i < 4; i++) { s.key(KEY.down); await sleep(350); } await sleep(1800); dumpScreen(s); s.key(KEY.esc); await sleep(600);
    scene(s, 'pi-clipboard-image · pi-user-image-previews  —  Alt+V pastes a screenshot');
    s.key(KEY.altV); await s.waitFor('Image #1 attached'); await sleep(900);
    await ask(s, 'why does signup fail?', 'email validator', 2500);
    scene(s, 'pi-session-finder  —  /session-global searches every project');
    await s.type('/session-global', 45); await sleep(300); s.key(KEY.enter); await s.waitFor('Find session'); await sleep(1000);
    for (const ch of 'rate') { s.key(ch); await sleep(160); } await sleep(1000); s.key(KEY.down); await sleep(1200); dumpScreen(s);
  } finally { clearInterval(timer); sample(s); }
} finally { s.kill(); }
if (process.env.DRY) process.exit(0);

// --- render: batches of frames on one page, one element screenshot each -----
const dir = join(HERE, 'html', 'demo'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const AB = (...a) => execFileSync('agent-browser', ['--session', 'pi-demo', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
AB('open', 'about:blank'); AB('set', 'viewport', '1400', '1000', process.env.DPR ?? '2');
const frameHTML = (f, i) => page({ panels: [{ label: f.label, labelKind: 'after', title: f.title || 'pi', view: { cols: COLS, rows: f.snap.lines.map((cells, y) => ({ cells, y, images: f.snap.images.filter(im => im.y === y) })) } }] })
  .replace('<div class="shot">', `<div class="shot" id="f${i}">`);
for (let b = 0; b < frames.length; b += 40) {
  const html = frames.slice(b, b + 40).map((f, k) => frameHTML(f, b + k)).join('\n').replace('</style>', '.shot{display:block;width:max-content}</style>');
  writeFileSync(join(dir, `batch-${b}.html`), html);
  AB('open', `file://${join(dir, `batch-${b}.html`)}`); AB('wait', '300');
  for (let i = b; i < Math.min(b + 40, frames.length); i++) {
    // Element screenshots don't scroll: show only frame i, at the top of the viewport.
    AB('eval', `document.querySelectorAll('.shot').forEach(e => e.style.display = e.id === 'f${i}' ? 'block' : 'none')`);
    AB('screenshot', `#f${i}`, join(dir, `f${i}.png`));
  }
  process.stdout.write(`\rrendered ${Math.min(b + 40, frames.length)}/${frames.length}`);
}
AB('close'); console.log();

// --- encode: one global palette, then each frame as the changed rectangle ----
const load = i => PNG.sync.read(readFileSync(join(dir, `f${i}.png`)));
const first = load(0); const { width: W, height: H } = first;
const sampleIdx = [...new Set([0, frames.length >> 1, frames.length - 1, frames.findIndex(f => f.snap.images.length)].filter(i => i >= 0))];
const pool = Buffer.concat(sampleIdx.map(i => load(i).data));
const TRANSPARENT = 255;
const palette = quantize(pool, 255).concat(Array(256).fill([0, 0, 0])).slice(0, 256);
const buf = Buffer.alloc(W * H * frames.length + 1e6);
const gif = new GifWriter(buf, W, H, { loop: 0, palette: palette.map(([r, g, b]) => (r << 16) | (g << 8) | b) });
let prev = null;
for (let i = 0; i < frames.length; i++) {
  const png = i ? load(i) : first;
  if (png.width !== W || png.height !== H) throw new Error(`frame ${i} is ${png.width}x${png.height}, expected ${W}x${H}`);
  const idx = applyPalette(png.data, palette.slice(0, 255));
  let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
  if (prev) {
    x0 = W; y0 = H; x1 = -1; y1 = -1;
    for (let p = 0; p < idx.length; p++) if (idx[p] !== prev[p]) { const x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) { x0 = y0 = x1 = y1 = 0; }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, sub = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = (y0 + y) * W + x0 + x; sub[y * w + x] = prev && idx[p] === prev[p] ? TRANSPARENT : idx[p]; }
  const ms = i + 1 < frames.length ? Math.min(frames[i + 1].t - frames[i].t, MAX_HOLD) : END_HOLD;
  gif.addFrame(x0, y0, w, h, sub, { delay: Math.max(2, Math.round(ms / 10)), disposal: 1, ...(prev ? { transparent: TRANSPARENT } : {}) });
  prev = idx;
}
writeFileSync(OUT, buf.subarray(0, gif.end()));
const secs = (frames.at(-1).t - frames[0].t) / 1000;
console.log(`ok   ${OUT}: ${frames.length} frames, ~${secs.toFixed(0)}s, ${W}x${H}, ${(gif.end() / 1e6).toFixed(2)} MB`);

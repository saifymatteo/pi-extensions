// npm run screenshots -- [name...]  — regenerate packages/<name>/screenshot.png
// (all when no names). Each scenario returns { panels, caption? }.
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, utimesSync, realpathSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { session, KEY, ROOT, HERE, sleep } from './lib.mjs';
import { rows, page, capture, closeBrowser, lineText } from './render.mjs';

const TITLE = 'pi — ~/acme-api';
const dump = snap => snap.lines.map(lineText).join('\n');

// Run one interactive session: start, optional prompt, then steps(s).
async function run(opts, steps) {
  const s = await session(opts);
  try {
    await s.waitFor(/demo-model|\(main\)/, 30000);
    await s.settle(400);
    const out = await steps(s);
    if (process.env.DUMP) console.log(`--- ${opts.extensions?.join(',') || 'stock'}\n${dump(s.snapshot())}`);
    return out ?? s.snapshot();
  } finally { s.kill(); }
}
async function prompt(s, text, until, settle = 700) {
  await s.type(text); s.key(KEY.enter);
  await s.waitFor(until, 30000); await s.settle(settle);
}

const before = view => ({ label: 'Stock pi', labelKind: 'before', title: TITLE, view });
const after = (name, view, extra = {}) => ({ label: `With ${name}`, labelKind: 'after', title: TITLE, view, ...extra });
const solo = (view, extra = {}) => ({ title: TITLE, view, ...extra });

const wav = () => { const b = Buffer.alloc(44); b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0, 40); return b; };
const serviceModels = { 'agent/extensions/service-models.json': ({ port }) => ({ providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'demo-key', models: [
  { id: 'triage-1', type: 'classifier', api: 'openai-decisions', contextWindow: 8192, input: ['text'], description: 'Fast ticket triage' },
  { id: 'kokoro', type: 'tts', api: 'openai-audio-speech', voice: 'af_heart' },
] } } }) };
// files whose content depends on the provider port
const portFiles = map => ({ agent, port }) => { for (const [rel, fn] of Object.entries(map)) { const p = join(agent, rel.slice(6)); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(fn({ port }), null, 2)); } };
export const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

export const BUG_PNG = join(HERE, 'assets', 'bug.png');
export const CLIP_ENV = { NODE_OPTIONS: `--require ${join(HERE, 'fake-clip.cjs')}`, FAKE_CLIP_PNG: BUG_PNG };
export const KITTY = { PI_IMAGE_PROTOCOL: 'kitty' };
const lastUserText = req => { const m = [...(req.messages ?? [])].reverse().find(x => x.role === 'user'); return typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(p => p.text ?? '').join(' '); };
export const allText = req => JSON.stringify(req.messages ?? []);
const footerFrom = snap => { const L = snap.lines; const i = L.findIndex(l => /~\/acme-api/.test(lineText(l))); return rows(snap, { from: i - 1 }); };

// --- seeded session store ---------------------------------------------------
const DAY = 864e5;
const hex8 = () => randomUUID().slice(0, 8);
// One JSONL session. conv: [[user, assistant], ...]; ageDays sets header time and mtime.
function writeSession(agent, { cwd, conv, name, ageDays = 0, parent }) {
  const t = Date.now() - ageDays * DAY;
  const iso = new Date(t).toISOString();
  const id = randomUUID();
  const dir = join(agent, 'sessions', `--${cwd.replace(/^\//, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${iso.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const lines = [{ type: 'session', version: 3, id, timestamp: iso, cwd, ...(parent ? { parentSession: parent } : {}) }];
  let prev = null;
  const push = e => { const eid = hex8(); lines.push({ ...e, id: eid, parentId: prev, timestamp: iso }); prev = eid; };
  for (const [u, a] of conv) {
    push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: u }], timestamp: t } });
    push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: a }], api: 'openai-completions', provider: 'demo', model: 'demo-model', usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: t } });
  }
  if (name) push({ type: 'session_info', name });
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(file, new Date(t), new Date(t));
  return file;
}
const PROJECTS = home => ({ api: join(home, 'acme-api'), web: join(home, 'acme-web'), infra: join(home, 'infra') });
export function seedStore({ home, agent }, { old = false } = {}) {
  const P = PROJECTS(home);
  for (const p of Object.values(P)) mkdirSync(p, { recursive: true });
  const s = (cwd, name, u, ageDays, parent) => writeSession(agent, { cwd, name, ageDays, parent, conv: [[u, 'Done — see the diff above.']] });
  const base = s(P.api, 'Rate limiting for /login', 'add rate limiting to the login endpoint', old ? 64 : 2);
  s(P.api, 'Rate limiting · Redis store', 'move the rate limiter state to redis', old ? 61 : 1, base);
  s(P.api, 'Health check route', 'add a /health route', 0.2);
  s(P.api, null, 'why is the users test flaky on CI?', old ? 95 : 6);
  s(P.web, 'Dark mode toggle', 'add a dark mode toggle to the settings page', old ? 48 : 3);
  s(P.web, 'Signup form validation', 'signup rejects emails with a plus sign', 0.5);
  s(P.web, null, 'bump vite to v7 and fix the build', old ? 120 : 9);
  s(P.infra, 'Terraform: staging DB', 'provision a staging postgres with terraform', old ? 77 : 4);
  const pr = s(P.infra, 'Nightly backup job', 'write a nightly pg_dump job', old ? 40 : 5);
  s(P.infra, 'Backup job · retention', 'keep 14 days of backups', old ? 38 : 5, pr);
}

export const SHOTS = {
  'pi-session-finder': async () => {
    const snap = await run({ extensions: ['pi-session-finder'], cols: 100, rows: 25, setup: d => seedStore(d) }, async s => {
      await s.type('/session-global'); s.key(KEY.enter); await s.waitFor('Find session'); await s.settle(400);
      s.key(KEY.down); s.key(KEY.down); await s.settle(300);
    });
    return { panels: [solo(rows(snap, { from: /Find session/, to: /Esc close/, box: true }))] };
  },
  'pi-session-nav': async () => {
    const turns = [
      { text: 'Added `GET /health` returning 200 ok.' },
      { text: 'The port now comes from `PORT` with 3000 as the default.' },
      { text: 'Tests cover both routes; all 12 pass.' },
      { text: 'Wrote a short README section on configuration.' },
    ];
    const snap = await run({ extensions: ['pi-session-nav'], cols: 100, rows: 16, turns }, async s => {
      await prompt(s, 'add a /health route', '200 ok');
      await prompt(s, 'read the port from the environment', 'default.');
      await prompt(s, 'add tests for both', '12 pass');
      await prompt(s, 'document the config in the README', 'configuration.');
      s.key(KEY.altO); await s.waitFor('Navigate conversation'); await s.settle(300);
      s.key(KEY.up); s.key(KEY.up); s.key(KEY.up); await s.settle(400);
    });
    return { panels: [solo(rows(snap, { from: /Navigate conversation/, to: /Esc close/, box: true }))] };
  },
  'pi-session-retention': async () => {
    const trashState = ({ agent }) => {
      const root = join(agent, 'sessions');
      const dir = join(agent, '.trash', `sessions-${createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 12)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ approved: false, paused: true, lastRun: Date.now() }));
    };
    const snap = await run({ extensions: ['pi-session-retention'], cols: 100, rows: 40, keepSession: true, setup: d => { seedStore(d, { old: true }); trashState(d); } }, async s => {
      await s.type('/session-cleanup preview'); await s.settle(300); s.key(KEY.enter); await s.settle(500); if (!/Preview only/.test(s.screen())) s.key(KEY.enter); await s.waitFor(/Preview only/); await s.settle(500);
    });
    return { panels: [solo(rows(snap, { from: /Preview only/, to: /\bNo\b/ }))] };
  },
  'pi-skill-usage-log': async () => {
    const skills = { 'tdd': 'Test-driven development loop', 'code-review': 'Review a branch against standards', 'diagnosing-bugs': 'Diagnosis loop for hard bugs', 'pr': 'Write a PR body', 'release-notes': 'Draft release notes from merged PRs', 'grilling': 'Stress-test a plan' };
    const files = {};
    for (const [n, d] of Object.entries(skills)) files[`agent/skills/${n}/SKILL.md`] = `---\nname: ${n}\ndescription: ${d}\n${n === 'pr' || n === 'grilling' ? 'disable-model-invocation: true\n' : ''}---\n\n# ${n}\n`;
    const usage = { tdd: [9, 7], 'code-review': [7, 6], 'diagnosing-bugs': [5, 3], pr: [6, 6], 'release-notes': [2, 1] };
    const models = ['openai/gpt-6', 'anthropic/claude-sonnet-5-5'];
    const rowsTsv = [];
    let k = 0;
    for (const [skill, [loaded, used]] of Object.entries(usage)) for (let i = 0; i < loaded; i++) {
      const t = new Date(Date.now() - (k++ * 7.3 + 1) * 3600e3); const ts = t.toISOString().replace('Z', '+00:00');
      const sid = `s${(i * 13 + skill.length) % 17}`; const cwd = ['/tmp/demo/acme-api', '/tmp/demo/acme-web', '/tmp/demo/infra'][i % 3];
      const m = models[i % 2]; const th = ['medium', 'high'][i % 2];
      rowsTsv.push([ts, sid, cwd, 'skill:load', skill, `/tmp/demo/.pi/agent/skills/${skill}/SKILL.md`, m, th].join('\t'));
      if (i < used) rowsTsv.push([ts, sid, cwd, 'skill:complete', skill, `/tmp/demo/.pi/agent/skills/${skill}/SKILL.md`, m, th].join('\t'));
    }
    files['agent/skill-usage.log'] = rowsTsv.join('\n') + '\n';
    const snap = await run({ extensions: ['pi-skill-usage-log'], cols: 100, rows: 50, files, skills: true, env: { TZ: 'Asia/Kuala_Lumpur' } }, async s => {
      await s.type('/skill-usage'); s.key(KEY.enter); await s.waitFor(/Skill usage/); await s.settle(500);
    });
    return { panels: [solo(rows(snap, { from: /Skill usage/, to: /Esc close/, box: true }))] };
  },
  'pi-tool-usage-log': async () => {
    const plan = { read: [412, 0], bash: [268, 11], edit: [154, 4], grep: [97, 0], write: [38, 1], find: [21, 0], ls: [12, 0] };
    const lines = []; let k = 0;
    const off = '+08:00';
    for (const [tool, [calls, errors]] of Object.entries(plan)) for (let i = 0; i < calls; i++) {
      const t = new Date(Date.now() - (k++ * 0.37) * 3600e3 + 8 * 3600e3);
      lines.push(JSON.stringify({ version: 1, timestamp: t.toISOString().replace('Z', off), session: `s${i % 23}`, cwd: ['/tmp/demo/acme-api', '/tmp/demo/acme-web', '/tmp/demo/infra'][i % 3], tool, callId: `c${k}`, ...(i % 9 === 0 ? { parentCallId: `p${k}` } : {}), model: i % 3 ? 'openai/gpt-6' : 'anthropic/claude-sonnet-5-5', thinking: i % 2 ? 'high' : 'medium', status: i < errors ? 'error' : 'success', durationMs: { read: 14, bash: 1840, edit: 22, grep: 61, write: 9, find: 48, ls: 6 }[tool] + (i * 37) % 90 }));
    }
    const snap = await run({ extensions: ['pi-tool-usage-log'], cols: 100, rows: 48, files: { 'agent/tool-usage.log': lines.join('\n') + '\n' }, env: { TZ: 'Asia/Kuala_Lumpur' } }, async s => {
      await s.type('/tool-usage'); s.key(KEY.enter); await s.waitFor(/Tool usage/); await s.settle(500);
    });
    return { panels: [solo(rows(snap, { from: /Tool usage/, to: /Esc close/, box: true }))] };
  },
  'pi-9router': async () => {
    const models = [
      { id: 'kr/claude-sonnet-4.5', owned_by: 'kr', capabilities: { vision: true, reasoning: true, thinkingFormat: 'claude-budget', thinkingCanDisable: true, contextWindow: 200000, maxOutput: 64000 } },
      { id: 'kr/claude-haiku-4.5', owned_by: 'kr', capabilities: { vision: true, reasoning: true, thinkingFormat: 'claude-budget', thinkingCanDisable: true, contextWindow: 200000, maxOutput: 32000 } },
      { id: 'cx/gpt-6-luna', owned_by: 'cx', capabilities: { vision: true, reasoning: true, thinkingFormat: 'openai', thinkingCanDisable: true, contextWindow: 400000, maxOutput: 128000 } },
      { id: 'cx/gpt-6-luna[1m]', owned_by: 'cx', capabilities: { vision: true, reasoning: true, thinkingFormat: 'openai', thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 128000 } },
      { id: 'ag/gemini-4-argon-high', owned_by: 'ag', capabilities: { vision: true, reasoning: true, thinkingFormat: 'gemini-level', thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 64000 } },
      { id: 'omlx/Ling-3.0-tiny-oQ6e', owned_by: 'omlx', capabilities: { vision: false, reasoning: true, thinkingFormat: 'qwen', thinkingCanDisable: true, contextWindow: 262144, maxOutput: 32000 } },
      { id: 'ollama/gemma4:cloud', owned_by: 'ollama', capabilities: { vision: true, reasoning: false, contextWindow: 128000, maxOutput: 8192 } },
      { id: 'nous/meituan/longcat-2.5-preview:free', owned_by: 'nous', capabilities: { vision: false, reasoning: true, thinkingFormat: 'nous', thinkingCanDisable: false, contextWindow: 262144, maxOutput: 32000 } },
      { id: 'oc/jev-1.13-free', owned_by: 'oc', capabilities: { vision: false, reasoning: false, contextWindow: 200000, maxOutput: 32000 } },
    ];
    const snap = await run({ cols: 110, rows: 36, setup: ({ agent, port }) => {
      mkdirSync(join(agent, 'extensions'), { recursive: true });
      writeFileSync(join(agent, 'extensions', '9router.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1` }, null, 2));
      // pi's picker only lists models from configured providers; seed the login
      // credential the extension's /login flow would have persisted.
      writeFileSync(join(agent, 'auth.json'), JSON.stringify({ '9router': { type: 'oauth', access: 'demo-key', refresh: 'demo-key', expires: Number.MAX_SAFE_INTEGER } }, null, 2));
    }, routes: { '/models': (req, res) => json(res, { data: models }) }, extensions: ['pi-9router'] }, async s => {
      await s.type('/model'); s.key(KEY.enter); await s.waitFor(/model/i); await s.settle(1000);
      s.type('claude'); await s.settle(500);
      s.key(KEY.down); await s.settle(300);
    });
    return { panels: [solo(rows(snap, { from: /model/i, to: /Esc/, box: true }))] };
  },
  'pi-model-go': async () => {
    const fetched = Date.now();
    const files = {
      'agent/state/model-go/go-plan.json': { fetched, value: { price: 10, limits: [
        { name: 'DeepSeek V4.1 Flash (Off-Peak)', input: 0.15, limit: 80, base: 20 }, { name: 'DeepSeek V4.1 Flash (Peak)', input: 0.30, limit: 80 },
        { name: 'GLM-5.3', input: 1.4, limit: 15 }, { name: 'GLM-5.3-Flash', input: 0.4, limit: 40 }, { name: 'Kimi K3', input: 1.2, limit: 20, base: 10 },
        { name: 'Qwen3.8 Max', input: 1.6, limit: 12 }, { name: 'Qwen3.8 Flash', input: 0.2, limit: 60 }, { name: 'MiniMax-M3', input: 0.6, limit: 30 },
        { name: 'MiMo V2.5 Pro', input: 1.0, limit: 20 }, { name: 'Claude Haiku 5.5', input: 1.0, limit: 10 },
      ] } },
      'agent/state/model-go/bench.json': { fetched, value: { 'deepseek-v4-1-flash': 41, 'glm-5-3': 52, 'glm-5-3-flash': 38, 'kimi-k3': 58, 'qwen3-8-max': 55, 'qwen3-8-flash': 36, 'minimax-m3': 47, 'mimo-v2-5-pro': 44, 'claude-haiku-5-5': 46 } },
    };
    const snap = await run({ cols: 110, rows: 36, files, extensions: ['pi-model-go'], env: { OPENCODE_API_KEY: 'demo' } }, async s => {
      await s.type('/model-go'); s.key(KEY.enter); await s.waitFor(/model-go ·/); await s.settle(800);
      s.key(KEY.down); s.key(KEY.down); await s.settle(300);
    });
    return { panels: [solo(rows(snap, { from: /model-go ·/, to: /Esc close/, box: true }))] };
  },
  'pi-clipboard-image': async () => {
    const turns = [{ text: 'The signup returns **500** on `POST /users` — the `+` in `sam+test@acme.dev` is rejected by the email validator.' }];
    let draft;
    const sent = await run({ extensions: ['pi-clipboard-image'], cols: 92, rows: 40, turns, env: CLIP_ENV }, async s => {
      s.key(KEY.altV); await s.waitFor('Image #1 attached'); await s.settle(300);
      await s.type('why does signup fail?'); await s.settle(300);
      draft = s.snapshot();
      s.key(KEY.enter); await s.waitFor('email validator'); await s.settle(700);
    });
    return { panels: [
      solo(rows(draft, { from: /Image #1 attached/, to: /why does signup fail/ }), { label: 'Copy a screenshot, press Alt+V in pi', highlight: [/\[Image #1\]/] }),
      solo(rows(sent, { from: /why does signup fail/, to: /email validator/ }), { label: 'The image goes to the model with your message' }),
    ] };
  },
  'pi-user-image-previews': async () => {
    const turns = () => [{ text: 'The form shows a **500** from `POST /users`; the email field is flagged red.' }];
    const args = ['@signup.png', 'why does signup fail?'];
    const go = s => s.waitFor('flagged red').then(() => s.settle(800));
    const files = { 'acme-api/signup.png': readFileSync(BUG_PNG) };
    const stock = await run({ cols: 92, rows: 50, turns: turns(), args, env: KITTY, files }, go);
    let folded;
    const expanded = await run({ extensions: ['pi-user-image-previews'], cols: 92, rows: 50, turns: turns(), args, env: KITTY, files }, async s => {
      await go(s); folded = s.snapshot();
      s.key(KEY.ctrlO); await s.settle(800);
    });
    const v = snap => rows(snap, { from: /why does signup fail/, to: /flagged red/ });
    return { panels: [before(v(stock)), after('pi-user-image-previews', v(folded)), { label: 'Ctrl+O opens the preview inline', labelKind: 'after', title: TITLE, view: v(expanded) }] };
  },
  'pi-vision': async () => {
    const models = port => ({ providers: { demo: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'demo', models: [
      { id: 'demo-model', name: 'demo-model', input: ['text'], contextWindow: 200000 },
      { id: 'demo-vision', name: 'demo-vision', input: ['text', 'image'], contextWindow: 200000 },
    ] } } });
    const reply = req => {
      const m = /\[vision model description\] (.*?)(?:\\n|")/.exec(allText(req));
      return { text: m ? `The image shows: *${m[1].trim()}* So the \`+\` in the email is what breaks signup.` : "I can't see images — this model only accepts text. Could you describe the screenshot?" };
    };
    const routes = { nonstream: (req, res) => json(res, { choices: [{ message: { content: 'a signup form; the email sam+test@acme.dev is outlined red; a banner reads 500 Internal Server Error on POST /users.' } }] }) };
    const args = ['@signup.png', 'why does signup fail?'];
    const go = s => s.waitFor(/signup\.\s*$|describe the screenshot/m).then(() => s.settle(800));
    const files = { 'agent/extensions/vision-toolkit.json': { model: 'demo/demo-vision', lang: 'en' }, 'acme-api/signup.png': readFileSync(BUG_PNG) };
    const one = async ext => {
      return run({ extensions: ext, cols: 92, rows: 40, turns: reply, routes, args, files, setup: ({ agent, port }) => writeFileSync(join(agent, 'models.json'), JSON.stringify(models(port))) }, go);
    };
    const stock = await one([]); const withExt = await one(['pi-vision']);
    const v = snap => rows(snap, { from: /why does signup fail/, to: /signup\.\s*$|describe the screenshot/m });
    return { panels: [{ ...before(v(stock)), label: 'Stock pi on a text-only model' }, after('pi-vision', v(withExt), { highlight: [/The image shows/] })],
      caption: 'Main model: text-only. pi-vision asks the configured vision model to describe the image and hands the description to the main model.' };
  },
  'pi-session-id': async () => {
    const snap = await run({ extensions: ['pi-session-id'], cols: 92, rows: 16, env: CLIP_ENV, keepSession: true }, async s => {
      await s.type('/session-id'); s.key(KEY.enter); await s.waitFor('Copied session ID'); await s.settle(400);
    });
    return { panels: [solo(rows(snap, { from: /Copied session ID/, footer: 5 }), { highlight: [/Copied session ID/] })] };
  },
  'pi-claude-usage': async () => {
    const now = Date.now();
    const files = { 'agent/state/claude-usage.json': { fiveHour: { pct: 42, resetsAt: now + (2 * 60 + 13) * 60e3 }, sevenDay: { pct: 78, resetsAt: now + (3 * 24 + 4) * 3600e3 }, rejected: false, overage: false } };
    // Cache-only demo: select the supported provider identity without loading Claude Code.
    const models = { providers: { 'claude-code': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'demo', models: [{ id: 'demo-model', name: 'demo-model', contextWindow: 200000 }] } } };
    const opts = { cols: 92, rows: 12, files, models, settings: { defaultProvider: 'claude-code' } };
    const stock = await run(opts, () => {});
    const withExt = await run({ ...opts, extensions: ['pi-claude-usage'] }, s => s.waitFor('Claude 5h').then(() => s.settle(300)));
    return { panels: [before(footerFrom(stock)), after('pi-claude-usage', footerFrom(withExt), { highlight: [/Claude 5h/] })] };
  },
  'pi-prestart-working': async () => {
    const demo = join('/tmp', 'pi-shots-demo-ext', 'memory-recall.ts');
    mkdirSync(dirname(demo), { recursive: true });
    writeFileSync(demo, 'export default function (pi) { pi.on("before_agent_start", async () => { await new Promise(r => setTimeout(r, 6000)); }); }\n');
    const turns = () => [{ text: 'Done.' }];
    const go = async s => { await s.type('summarise yesterday\'s changes'); s.key(KEY.enter); await s.settle(1800); };
    const v = snap => { const i = snap.lines.findIndex(l => /~\/acme-api/.test(lineText(l))); return rows(snap, { from: i - 3 }); };
    const stock = await run({ extensions: [demo], cols: 92, rows: 18, turns: turns() }, go);
    const withExt = await run({ extensions: ['pi-prestart-working', demo], cols: 92, rows: 18, turns: turns() }, async s => { await s.type('summarise yesterday\'s changes'); s.key(KEY.enter); await s.waitFor('Loading memory-recall'); await s.settle(300); });
    return { panels: [{ ...before(v(stock)), label: 'Stock pi: a slow before_agent_start hook leaves the UI silent' }, after('pi-prestart-working', v(withExt), { highlight: [/Loading memory-recall/] })],
      caption: 'Just after pressing Enter, while a slow before_agent_start hook (here a demo "memory-recall" extension) is still running.' };
  },
  'pi-session-rename': async () => {
    const turns = req => /starts a new topic/.test(allText(req))
      ? { text: '{"isNewTopic": true, "title": "Fix flaky login token refresh"}' }
      : { text: 'The refresh races the expiry check; moving it behind the mutex fixes it.', delay: 400 };
    const files = { 'agent/extensions/session-rename.json': { model: 'demo/demo-model', thinking: 'off' } };
    const go = s => prompt(s, 'the login test fails randomly when the token refresh runs', 'fixes it', 1200);
    const env = { HERDR_ENV: '', HERDR_TAB_ID: '' };
    let stockTitle, extTitle;
    const stock = await run({ cols: 92, rows: 16, turns, files, env, keepSession: true }, async s => { await go(s); stockTitle = s.title; });
    const withExt = await run({ extensions: ['pi-session-rename'], cols: 92, rows: 16, turns, files, env, keepSession: true }, async s => { await go(s); await s.waitFor('Fix flaky'); extTitle = s.title; });
    const v = snap => rows(snap, { from: /the login test fails/, footer: 3 });
    return { panels: [{ ...before(v(stock)), title: stockTitle || 'pi' }, after('pi-session-rename', v(withExt), { title: extTitle, highlight: [/Fix flaky/] })] };
  },
  'pi-bg-bash': async () => {
    const cmd = 'npm test --silent';
    const files = { 'acme-api/package.json': JSON.stringify({ name: 'acme-api', scripts: { test: "sleep 4 && echo '✔ 42 tests passed' && echo 'coverage 91%'" } }, null, 2) };
    const turns = [
      { tools: [{ name: 'bash', args: { command: cmd, background: true } }] },
      { text: "Tests are running in the background — I'll keep going on the router meanwhile." },
      { text: 'All 42 tests passed with 91% coverage.' },
    ];
    let collapsed;
    const expanded = await run({ extensions: ['pi-bg-bash'], cols: 92, rows: 50, turns, files }, async s => {
      await prompt(s, 'run the test suite, but keep working while it runs', '91% coverage', 900);
      collapsed = s.snapshot();
      s.key(KEY.ctrlO); await s.settle(600);
    });
    const v = snap => rows(snap, { from: /run the test suite/, to: /91% coverage\./ });
    return { panels: [
      solo(v(collapsed), { label: 'The agent keeps working; the result arrives on its own', highlight: [/Background/] }),
      solo(rows(expanded, { from: /Tests are running/, to: /91% coverage\./ }), { label: 'Ctrl+O shows the output tail', highlight: [/Background/] }),
    ] };
  },
  'pi-wait': async () => {
    const turns = [
      { tools: [{ name: 'bash', args: { command: "sleep 3 && echo 'built dist/ in 2.8s'", background: true } }] },
      { tools: [{ name: 'wait', args: { jobs: ['shell:1'], timeoutMs: 60000 } }] },
      { text: 'Build finished — `dist/` is ready to deploy.' },
    ];
    const snap = await run({ extensions: ['pi-bg-bash', 'pi-wait'], cols: 92, rows: 50, turns }, s => prompt(s, 'build in the background, then deploy once it is done', 'ready to deploy', 900));
    return { panels: [solo(rows(snap, { from: /build in the background/, to: /ready to deploy/ }), { highlight: [/^\s*wait\b/] })] };
  },
  'pi-root-guard': async () => {
    const turns = () => [
      { tools: [{ name: 'write', args: { path: '~/.pi/agent/settings.json', content: '{ "defaultModel": "gpt-5" }\n' } }] },
      { text: "I can't write to the Pi config root — please change the default model yourself." },
    ];
    const go = s => prompt(s, 'make gpt-5 my default model', 'yourself');
    const v = snap => rows(snap, { from: /make gpt-5/, to: /yourself|Done\./ });
    const stockTurns = turns(); stockTurns[1] = { text: 'Done.' };
    const stock = await run({ cols: 92, rows: 40, turns: stockTurns }, s => prompt(s, 'make gpt-5 my default model', 'Done.'));
    const withExt = await run({ extensions: ['pi-root-guard'], cols: 92, rows: 40, turns: turns() }, go);
    return { panels: [
      { ...before(v(stock)), label: 'Stock pi: the agent rewrites its own config' },
      after('pi-root-guard', v(withExt), { highlight: [/pi-root-guard/, /blocked path/] }),
    ] };
  },
  'pi-decisions': async () => {
    const turns = [
      { tools: [{ name: 'classify', args: {
        state: { ticket: 'POST /users returns 500 when the email contains a plus sign' },
        questions: {
          severity: { type: 'choice', instructions: 'How severe is this?', criteria: { low: 'cosmetic', medium: 'degraded', high: 'core flow broken' } },
          is_regression: { type: 'bool', instructions: 'Is it likely a regression?', criteria: { true: 'worked before', false: 'never worked' } },
        } } }] },
      { text: 'Triage: **high** severity (86%), probably a regression (78%). Filing it for this sprint.' },
    ];
    const routes = { '/decisions': (req, res) => json(res, { answers: [
      { name: 'severity', type: 'choice', choice: 'high', confidence: 0.86, probabilities: [{ value: 'low', probability: 0.03 }, { value: 'medium', probability: 0.11 }, { value: 'high', probability: 0.86 }] },
      { name: 'is_regression', type: 'predicate', probability: 0.78 },
    ], usage: { input_tokens: 412, output_tokens: 9 } }) };
    const snap = await run({ extensions: ['pi-decisions'], cols: 92, rows: 50, turns, routes, setup: portFiles(serviceModels) }, s => prompt(s, 'triage the new bug report', 'this sprint'));
    return { panels: [solo(rows(snap, { from: /triage the new bug/, to: /this sprint/ }), { highlight: [/"choice": "high"/] })] };
  },
  'pi-tts': async () => {
    const turns = [
      { tools: [{ name: 'text_to_speech', args: { text: 'Release 2.4 is live. All forty-two tests passed.', output_file: 'release-notes.wav' } }] },
      { text: 'Saved the announcement to `release-notes.wav`.' },
    ];
    const routes = { '/audio/speech': (req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav()); } };
    const snap = await run({ extensions: ['pi-tts'], cols: 92, rows: 40, turns, routes, setup: portFiles(serviceModels) }, s => prompt(s, 'record a short release announcement', 'Saved the'));
    return { panels: [solo(rows(snap, { from: /record a short/, to: /Saved the/ }), { highlight: [/output_file/] })] };
  },
  'pi-codegraph': async () => {
    const turns = [
      { tools: [{ name: 'codegraph_explore', args: { query: 'router createServer PORT', maxFiles: 3 } }] },
      { text: '`server.ts` passes `router` to `createServer`; the port is the `PORT` constant.' },
    ];
    const snap = await run({ extensions: ['pi-codegraph'], cols: 92, rows: 90, turns }, async s => {
      await s.waitFor(/CodeGraph: synced/, 60000);
      await prompt(s, 'how does the server wire up the router?', 'PORT constant');
      s.key(KEY.ctrlO); await s.settle(600);
    });
    return { panels: [solo(rows(snap, { from: /how does the server/, to: /PORT constant/, footer: 3 }), { highlight: [/CodeGraph: synced/] })] };
  },
  'pi-zvec': async () => {
    const turns = [
      { tools: [{ name: 'zvec_search', args: { query: 'where is the HTTP port configured', mode: 'hybrid', limit: 3 } }] },
      { text: 'The port is hard-coded as `PORT = 3000` in `src/server.ts`.' },
    ];
    const env = { ZVEC_GREP_MODEL_CACHE: `${process.env.HOME}/.zvec-grep/models`, ZVEC_GREP_MODE: 'direct' };
    const snap = await run({ extensions: ['pi-zvec'], cols: 92, rows: 46, turns, env }, async s => {
      await s.waitFor(/Zvec: indexed|Zvec: synced/, 90000);
      await prompt(s, 'where is the HTTP port configured?', 'src/server.ts', 900);
      s.key(KEY.ctrlO); await s.settle(600);
    });
    return { panels: [solo(rows(snap, { from: /where is the HTTP port/, to: /PORT = 3000/, footer: 3 }), { highlight: [/Zvec: /] })] };
  },
  'pi-load-pi-dotenv': async () => {
    const files = { 'agent/.env': 'DB_USER=acme\nDATABASE_URL=postgres://${DB_USER}@localhost:5432/acme\nSTRIPE_KEY=sk_test_51Hdemo\n' };
    const turns = () => [
      { tools: [{ name: 'bash', args: { command: 'echo "DATABASE_URL=$DATABASE_URL"; echo "STRIPE_KEY=$STRIPE_KEY"' } }] },
      { text: 'Checked the environment the tools see.' },
    ];
    const go = s => prompt(s, 'which DB and Stripe key will the tests use?', 'tools see');
    const v = snap => rows(snap, { from: /which DB/, to: /tools see/ });
    const stock = await run({ cols: 84, rows: 40, files, turns: turns() }, go);
    const withExt = await run({ extensions: ['pi-load-pi-dotenv'], cols: 84, rows: 40, files, turns: turns() }, go);
    return { panels: [before(v(stock)), after('pi-load-pi-dotenv', v(withExt), { highlight: [/^\s*(DATABASE_URL|STRIPE_KEY)=\S/] })],
      caption: '~/.pi/agent/.env:  DB_USER=acme · DATABASE_URL=postgres://${DB_USER}@localhost:5432/acme · STRIPE_KEY=sk_test_51Hdemo' };
  },
  'pi-codeblock-borders': async () => {
    const reply = [
      'Add a health route:',
      '',
      '```ts title="src/router.ts" :line-numbers',
      "import type { RequestListener } from 'node:http';",
      '',
      'export const router: RequestListener = (req, res) => {',
      "  if (req.url === '/health') {",
      "    return res.writeHead(200).end('ok');",
      '  }',
      '  res.writeHead(404).end();',
      '};',
      '```',
      '',
      'Then check it (line 2 is the one that matters):',
      '',
      '```bash {2}',
      'npm run dev &',
      'curl -s localhost:3000/health',
      'kill %1',
      '```',
    ].join('\n');
    const go = s => prompt(s, 'add a /health route', 'kill %1');
    const stock = await run({ cols: 84, rows: 50, turns: [{ text: reply }] }, go);
    const withExt = await run({ extensions: ['pi-codeblock-borders'], cols: 84, rows: 50, turns: [{ text: reply }] }, go);
    const tail = snap => { const L = snap.lines; const i = L.findLastIndex(l => /kill %1/.test(lineText(l))); return rows(snap, { from: /add a \/health route/, to: i + 1 }); };
    return { panels: [before(tail(stock)), after('pi-codeblock-borders', tail(withExt))] };
  },
  'pi-compact-tools': async () => {
    const turns = () => [
      { tools: [{ name: 'read', args: { path: 'src/server.ts' } }, { name: 'grep', args: { pattern: 'TODO', path: 'src' } }, { name: 'bash', args: { command: 'ls src && wc -l src/*.ts' } }] },
      { tools: [{ name: 'read', args: { path: 'src/router.ts' } }] },
      { text: 'Two TODOs: the port is hard-coded in `server.ts`, and `router.ts` has no `/health` route yet.' },
    ];
    const go = s => prompt(s, 'find the open TODOs', 'route yet');
    const stock = await run({ cols: 92, rows: 60, turns: turns() }, go);
    let folded;
    const expanded = await run({ extensions: ['pi-compact-tools'], cols: 92, rows: 60, turns: turns() }, async s => {
      await go(s); folded = s.snapshot();
      s.key(KEY.ctrlO); await s.settle(600);
    });
    const v = snap => rows(snap, { from: /find the open TODOs/, to: /route yet/ });
    return { panels: [
      before(v(stock)),
      after('pi-compact-tools', v(folded)),
      { label: 'Ctrl+O expands the card', labelKind: 'after', title: TITLE, view: v(expanded) },
    ] };
  },
};

// Importable (demo.mjs reuses the fixtures above); runs only as the entry point.
if (import.meta.main) {
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
let failed = 0;
for (const name of names) {
  const t0 = Date.now();
  try {
    const shot = await SHOTS[name]();
    const out = process.env.OUT ? join(process.env.OUT, `${name}.png`) : join(ROOT, 'packages', name, 'screenshot.png');
    capture(name, page(shot), out);
    console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${out}`);
  } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack}`); }
}
closeBrowser();
process.exit(failed ? 1 : 0);
}

// Measures the system-prompt and tool-schema context each package adds, by
// capturing the exact request Pi sends to a local HTTP provider.
// Run with: npm run context
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from './environment.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const home = mkdtempSync(join(tmpdir(), 'pi-context-audit-'));
const captured = [];
let serverPort = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && body.includes('"messages"')) {
      try { captured.push(JSON.parse(body)); } catch { /* ignore non-JSON POSTs */ }
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"audit capture - no model behind this endpoint"}}');
  });
});
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
serverPort = server.address().port;

writeFileSync(join(home, 'models.json'), JSON.stringify({
  $schema: 'https://pi.dev/schemas/models.schema.json',
  providers: {
    capture: {
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      api: 'openai-completions',
      apiKey: 'audit-dummy',
      models: [{ id: 'probe', input: ['text'] }],
    },
  },
}, null, 2));

// This repo's audience runs stock Pi, so the audit defaults to the pinned
// stock host from node_modules (the same version the typecheck pins). Set
// PI_HOST to measure against another host build.
const stockBin = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
if (!existsSync(stockBin)) throw new Error('Stock host not found: run npm install first');
const hostOverride = process.env.PI_HOST;
const hostCommand = hostOverride ? hostOverride : process.execPath;
const hostArgsPrefix = hostOverride ? [] : [stockBin];
const hostLabel = hostOverride
  ?? `stock pi ${JSON.parse(readFileSync(join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version} (node_modules)`;

// Agent Skills locations (~/.agents/skills, .agents/skills) live OUTSIDE the
// agent dir: point USERPROFILE/HOME at the isolated home so machine-level
// skills cannot leak into the measurement. cwd is the empty temp home.
const auditEnv = () => ({ ...isolatedEnvironment(home), USERPROFILE: home, HOME: home });

// Async spawn: the capture server lives in this process, so the event loop must
// stay free to answer the child's request while it runs.
const run = async label => {
  captured.length = 0;
  const args = ['--no-mcp', '--no-session', '--no-approve', '--no-context-files', '-p', '--model', 'capture/probe', 'hi'];
  if (label) args.splice(1, 0, '-e', label);
  // stdin must be ignored: print mode otherwise waits for piped input that never arrives.
  const child = spawn(hostCommand, [...hostArgsPrefix, ...args], { cwd: home, env: auditEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const outcome = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${label || 'baseline'}: timed out waiting for the request`)); }, 90_000);
    child.on('exit', code => { clearTimeout(timer); resolvePromise(code); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const request = captured[0];
  if (!request) throw new Error(`${label || 'baseline'}: no request captured (exit ${outcome})`);
  const system = request.messages?.find(message => message.role === 'system')?.content ?? '';
  const systemChars = typeof system === 'string' ? system.length : JSON.stringify(system).length;
  const toolsChars = request.tools ? JSON.stringify(request.tools).length : 0;
  return { label: label || '(baseline)', systemChars, toolsChars, toolCount: request.tools?.length ?? 0, systemText: system };
};

const baseline = await run(null);
// The baseline must be a machine-clean host prompt: an isolated agent home,
// USERPROFILE/HOME, and --no-context-files keep machine extensions, skills,
// and config out. Assert it. (The host prompt may embed its own install path;
// usernames there are host-authored, not leakage.)
const machineMarkers = /hindsight|vision-tools|herdr|orchestrator|atelier|agent-ask|agent-browser|find-skills/i;
const extensionTools = /"name"\s*:\s*"(zvec_search|codegraph_explore|wait)"/;
if (machineMarkers.test(baseline.systemText) || extensionTools.test(JSON.stringify(captured[0].tools ?? []))) {
  throw new Error('Baseline is not machine-clean: the captured prompt contains host-machine extensions, skills, or personal paths');
}

const inventory = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8'));
const entries = [{ name: 'ROOT (all packages + skill)', path: root }];
for (const { directory } of inventory.extensions) entries.push({ name: directory, path: join(root, 'packages', directory) });
// Serialized on purpose: one shared capture server cannot attribute parallel runs.
const rows = [];
for (const entry of entries) {
  const row = await run(entry.path);
  row.name = entry.name;
  row.deltaSystem = row.systemChars - baseline.systemChars;
  row.deltaTools = row.toolsChars - baseline.toolsChars;
  rows.push(row);
}
server.close();
// Best-effort on Windows: a just-exited child can still hold the temp dir briefly.
try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* disposable temp home */ }

const tokens = chars => `~${Math.round(chars / 4).toLocaleString()} tok`;
console.log(`Host: ${hostLabel}`);
console.log(`Baseline: system ${baseline.systemChars.toLocaleString()} chars (${tokens(baseline.systemChars)}), ${baseline.toolCount} built-in tools (${baseline.toolsChars.toLocaleString()} chars)\n`);
console.log('Per-package first-turn contribution (chars + approximate tokens at ~4 chars/token):');
console.log('package                              | Δsystem chars | ~Δtokens | Δtools chars | tools');
for (const row of rows.slice(1).sort((a, b) => b.deltaSystem + b.deltaTools - (a.deltaSystem + a.deltaTools))) {
  console.log(`${row.name.padEnd(36)} | ${String(row.deltaSystem).padStart(13)} | ${String(Math.round(row.deltaSystem / 4)).padStart(8)} | ${String(row.deltaTools).padStart(12)} | ${row.toolCount - baseline.toolCount}`);
}
const rootRow = rows[0];
console.log(`${'ROOT (all packages + skill)'.padEnd(36)} | ${String(rootRow.deltaSystem).padStart(13)} | ${String(Math.round(rootRow.deltaSystem / 4)).padStart(8)} | ${String(rootRow.deltaTools).padStart(12)} | ${rootRow.toolCount - baseline.toolCount}`);
console.log(`\nRoot total system prompt: ${rootRow.systemChars.toLocaleString()} chars (~${Math.round(rootRow.systemChars / 4).toLocaleString()} tokens), ${rootRow.toolCount} tools (${rootRow.toolsChars.toLocaleString()} chars of schemas)`);
const sumSystem = rows.slice(1).reduce((total, row) => total + row.deltaSystem, 0);
const sumTools = rows.slice(1).reduce((total, row) => total + row.deltaTools, 0);
console.log(`Per-package sum vs root: system ${sumSystem} vs ${rootRow.deltaSystem} chars, tools ${sumTools} vs ${rootRow.deltaTools} chars (differences = load-order interactions)`);

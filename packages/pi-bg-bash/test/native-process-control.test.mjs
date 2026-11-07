import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtension } from '../../../test/load-extension.mjs';

// Opt in: this launches and terminates only this test's disposable Node tree.
// PI_BG_NATIVE_TEST=1 node --test packages/pi-bg-bash/test/native-process-control.test.mjs
test('native stop retires a disposable parent and child process', {
  skip: process.env.PI_BG_NATIVE_TEST !== '1', timeout: 90_000,
}, async () => {
  const { captureProcess, stopProcessTree } = loadExtension(fileURLToPath(new URL('../src/lib/process-control.ts', import.meta.url)));
  const childCode = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)";
  const root = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => console.log(JSON.stringify({ child: child.pid })));
    process.on('SIGTERM', () => {});
    setTimeout(() => {}, 60000);
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(root, 'exit');
  let identity, childIdentity, childPid;
  try {
    const [chunk] = await once(root.stdout, 'data');
    childPid = JSON.parse(chunk.toString().trim()).child;
    identity = await captureProcess(root.pid);
    childIdentity = await captureProcess(childPid);
    const started = performance.now();
    assert.equal(await stopProcessTree(identity, 'force'), 'stopped');
    console.log(`native force: ${Math.round(performance.now() - started)}ms including discovery and verification`);
    await exited;
    await assert.rejects(captureProcess(childPid), /gone/);
  } catch (error) {
    console.error('native fixture failed before cleanup:', error);
    throw error;
  } finally {
    for (const captured of [childIdentity, identity].filter(Boolean)) {
      try { process.kill(captured.pid, 0); await stopProcessTree(captured, 'force'); } catch { /* Already exited or cleanup failed; fixtures self-expire. */ }
    }
    // ChildProcess retains the directly spawned fixture handle if identity capture failed.
    if (root.exitCode === null && root.signalCode === null) root.kill('SIGKILL');
  }
});

for (const name of process.platform === 'win32' ? ['bash', 'powershell'] : ['bash']) {
test(`native ${name} console supports graceful Ctrl+C and separate force kill through job controls`, {
  skip: process.env.PI_BG_NATIVE_TEST !== '1', timeout: 240_000,
}, async () => {
  const host = await import('@earendil-works/pi-coding-agent');
  const tools = new Map(), hooks = new Map(), commands = new Map();
  const folder = fs.mkdtempSync(join(tmpdir(), 'pi bg native-'));
  const script = join(folder, 'preview.cjs');
  fs.writeFileSync(script, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const marker = process.argv[2];
    const safety = setTimeout(() => process.exit(91), 90000);
    process.on('SIGINT', () => setTimeout(() => {
      fs.writeFileSync(marker, 'SIGINT cleanup completed');
      clearTimeout(safety);
    }, 200));
    const code = "const fs=require('node:fs'); const t=setTimeout(()=>process.exit(91),90000); process.on('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(process.argv[1], 'SIGINT child cleanup completed');clearTimeout(t);},100)); console.log('child-ready');";
    const child = spawn(process.execPath, ['-e', code, marker + '.child'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', () => {
      fs.writeFileSync(marker + '.ready', String(child.pid));
      console.log('native-preview-ready child=' + child.pid);
    });
  `);
  let mode = 'force';
  const { default: extension } = loadExtension(fileURLToPath(new URL('../src/index.ts', import.meta.url)), {
    '@earendil-works/pi-coding-agent': host,
    '@earendil-works/pi-tui': {},
    'node:os': { tmpdir: () => folder, homedir: () => folder },
    'node:fs': { ...fs, readdirSync: () => [] },
    './lib/panel': { showJobPanel: async (_ctx, api) => {
      const job = api.list().find(job => job.running);
      assert.ok(job, 'launched job appears in /bg');
      assert.match(await api.stop(job.id, mode), /tracked process tree is gone/);
    } },
  }, { crypto: globalThis.crypto });
  const ctx = { cwd: folder, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionFile: () => undefined, getBranch: () => [], getSessionId: () => 'native-test' },
    ui: { notify() {} },
  };
  extension({ registerTool: tool => tools.set(tool.name, tool), registerToolRenderer() {}, registerMessageRenderer() {},
    registerCommand: (name, options) => commands.set(name, options.handler),
    on: (name, fn) => hooks.set(name, fn), events: { on() {} }, getAllTools: () => [{ name: 'powershell' }],
    sendMessage: (_message, options) => assert.equal(options.triggerTurn, false),
  });
  try {
    await hooks.get('session_start')({}, ctx);
    for (mode of ['graceful', 'force']) {
        const marker = join(folder, `${name}-${mode}.marker`);
        let watcher, timer;
        const ready = new Promise((resolve, reject) => {
          watcher = fs.watch(folder, () => { if (fs.existsSync(marker + '.ready')) resolve(); });
          timer = setTimeout(() => reject(new Error(`${name} fixture did not become ready`)), 15000);
        });
        void ready.catch(() => {});
        try {
          const command = `node "${script.replace(/\\/g, '/')}" "${marker.replace(/\\/g, '/')}"`;
          const launch = await tools.get(name).execute('native-launch', { command, background: true }, undefined, undefined, ctx);
          if (!fs.existsSync(marker + '.ready')) await ready;
          const childPid = Number(fs.readFileSync(marker + '.ready', 'utf8'));
          const started = performance.now();
          await commands.get('bg')('', ctx);
          console.log(`native ${name} ${mode}: ${Math.round(performance.now() - started)}ms`);
          const result = await tools.get(name).execute('native-query', { job: String(launch.details.bgJob) }, undefined, undefined, ctx);
          assert.match(result.content[0].text, mode === 'graceful' ? /stopped gracefully by user/ : /force killed by user/);
          assert.equal(fs.existsSync(marker), mode === 'graceful', 'only graceful stop runs parent cleanup');
          assert.equal(fs.existsSync(marker + '.child'), mode === 'graceful', 'only graceful stop runs child cleanup');
          const { captureProcess } = loadExtension(fileURLToPath(new URL('../src/lib/process-control.ts', import.meta.url)));
          await assert.rejects(captureProcess(childPid), /gone/, 'no live orphaned child remains');
        } finally { watcher?.close(); clearTimeout(timer); }
    }
  } finally {
    await hooks.get('session_shutdown')({ reason: 'quit' }, ctx);
    try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { console.error('Native fixture directory still locked:', folder, error.code); }
  }
});
}

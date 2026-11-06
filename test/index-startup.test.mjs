import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadExtension } from './load-extension.mjs';

const Type = new Proxy({}, { get: () => () => ({}) });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const ok = { code: 0, stdout: 'ok', stderr: '', killed: false };

function harness(kind, { indexed = false, auto = false, windows = false, missing = false, holdConfig = false, holdGitignore = false, holdDiscovery = false } = {}) {
  const home = join(tmpdir(), 'pi-index-startup-fixture');
  const root = join(home, 'project');
  const cwd = join(root, 'subdir');
  const globalRoot = join(home, 'npm global');
  const entry = join(globalRoot, '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js');
  const versionEntered = deferred(), version = deferred(), configEntered = deferred(), config = deferred();
  const gitignoreEntered = deferred(), gitignore = deferred(), discoveryEntered = deferred(), discovery = deferred();
  const hooks = {}, commands = {}, tools = {}, calls = [], notifications = [], messages = [], writes = [];
  const files = new Set([
    join(home, 'agent', 'extensions', `${kind}.json`),
    ...(indexed ? [kind === 'zvec' ? join(root, '.zvec-grep') : join(root, '.codegraph', 'codegraph.db')] : []),
    entry,
  ]);
  const mod = loadExtension(new URL(`../packages/pi-${kind}/src/index.ts`, import.meta.url), {
    typebox: { Type },
    'node:os': { homedir: () => home },
    'node:fs': { existsSync: path => files.has(path), realpathSync: path => path, appendFileSync() {} },
    'node:child_process': { execSync() { throw new Error('Synchronous subprocess discovery is forbidden'); } },
    'node:fs/promises': {
      mkdir: async () => {},
      writeFile: async (path, data) => {
        writes.push({ path, data });
        files.add(path);
        if (holdGitignore && path.endsWith('.gitignore')) { gitignoreEntered.resolve(); await gitignore.promise; }
      },
      readFile: async path => {
        if (path === join(home, 'agent', 'extensions', `${kind}.json`)) {
          configEntered.resolve();
          if (holdConfig) await config.promise;
          return JSON.stringify({ autoInit: auto, syncOnSettle: auto, embedding: 'fixture/global' });
        }
        if (path === join(root, '.pi', `${kind}.json`) || path === join(cwd, '.pi', `${kind}.json`)) {
          return JSON.stringify({ embedding: 'fixture/project' });
        }
        throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      },
    },
  }, { process: { platform: windows ? 'win32' : 'linux', env: { PI_CODING_AGENT_DIR: join(home, 'agent') } } });
  const pi = {
    on: (name, handler) => { hooks[name] = handler; },
    registerTool: tool => { tools[tool.name] = tool; },
    registerCommand: (name, command) => { commands[name] = command; },
    sendMessage: message => { messages.push(message); },
    exec: async (command, args, options) => {
      calls.push({ command, args: [...args], options });
      if (args.includes('npm') && args.includes('root')) {
        discoveryEntered.resolve();
        if (holdDiscovery) await discovery.promise;
        return { ...ok, stdout: globalRoot };
      }
      if (args.includes('version')) {
        versionEntered.resolve();
        await version.promise;
        return { ...ok, code: missing ? 1 : 0 };
      }
      return ok;
    },
  };
  mod.default(pi);
  const ctx = {
    cwd, hasUI: true,
    sessionManager: { getSessionId: () => 'fixture' },
    ui: { setStatus() {}, notify: (text, level) => { notifications.push({ text, level }); } },
  };
  const tool = tools[kind === 'zvec' ? 'zvec_search' : 'codegraph_explore'];
  return {
    home, root, cwd, entry, hooks, commands, calls, notifications, messages, writes, ctx,
    versionEntered, version, configEntered, config, gitignoreEntered, gitignore, discoveryEntered, discovery,
    tool: (signal, context = ctx) => tool.execute('fixture', { query: 'a|b', mode: 'exact' }, signal, undefined, context),
    start: (context = ctx) => hooks.session_start({}, context),
    shutdown: () => hooks.session_shutdown({}, ctx),
    versions: () => calls.filter(call => call.args.includes('version')),
    writers: () => calls.filter(call => call.args.includes('index') || call.args.includes('init') || call.args.includes('sync')),
  };
}

for (const kind of ['zvec', 'codegraph']) {
  test(`${kind}: startup returns immediately; early tools share CLI and configuration initialization`, async () => {
    const h = harness(kind, { holdConfig: true });
    assert.equal(h.start(), undefined);
    assert.equal(h.calls.length, 0);
    const a = h.tool(), b = h.tool();
    await h.versionEntered.promise;
    assert.equal(h.versions().length, 1);
    assert.equal(h.calls.length, 1);
    h.version.resolve();
    await h.configEntered.promise;
    assert.equal(h.calls.length, 1, 'queries must wait for configuration too');
    h.config.resolve();
    await Promise.all([a, b]);
    assert.equal(h.versions().length, 1);
    assert.equal(h.calls.length, 3);
    assert.equal(h.writers().length, 0);
    await h.shutdown();
  });

  test(`${kind}: cancelling one early caller does not cancel shared setup for another`, async () => {
    const h = harness(kind);
    h.start();
    const abort = new AbortController();
    const a = h.tool(abort.signal), b = h.tool();
    const rejected = assert.rejects(a, /abort/i);
    await h.versionEntered.promise;
    abort.abort();
    h.version.resolve();
    await Promise.all([rejected, b]);
    assert.equal(h.versions().length, 1);
    assert.equal(h.calls.length, 2);
    await h.shutdown();
  });

  test(`${kind}: early manual init owns the writer slot and waits for project configuration`, async () => {
    const h = harness(kind, { auto: true });
    h.start();
    const manual = h.commands[`${kind}-init`].handler('', h.ctx);
    await h.versionEntered.promise;
    h.version.resolve();
    await manual;
    assert.equal(h.writers().length, 1, 'automatic init must not race manual init');
    const writer = h.writers()[0];
    assert.ok(writer.args.includes(h.cwd));
    if (kind === 'zvec') assert.ok(writer.args.includes('fixture/project'));
    assert.equal(h.messages.length, 1);
    await h.shutdown();
  });

  test(`${kind}: shutdown aborts initialization without queries, writers, or stale notifications`, async () => {
    const h = harness(kind, { auto: true });
    h.start();
    const query = h.tool();
    const rejected = assert.rejects(query, /abort/i);
    await h.versionEntered.promise;
    const stopping = h.shutdown();
    assert.equal(h.versions()[0].options.signal.aborted, true);
    h.version.resolve();
    await stopping;
    await rejected;
    assert.equal(h.calls.length, 1);
    assert.equal(h.writes.length, 0);
    assert.equal(h.notifications.length, 0);
  });

  test(`${kind}: shutdown during config loading prevents stale state and indexing`, async () => {
    const h = harness(kind, { auto: true, holdConfig: true });
    h.start();
    h.version.resolve();
    await h.configEntered.promise;
    const stopping = h.shutdown();
    h.config.resolve();
    await stopping;
    assert.equal(h.writers().length, 0);
    assert.equal(h.notifications.length, 0);
  });

  test(`${kind}: a cancelled probe is not cached as a missing CLI in the next session`, async () => {
    const h = harness(kind);
    h.start();
    await h.versionEntered.promise;
    const stopping = h.shutdown();
    h.version.resolve();
    await stopping;
    h.start();
    await h.tool();
    assert.equal(h.versions().length, 2);
    assert.equal(h.notifications.length, 0);
    await h.shutdown();
  });

  test(`${kind}: replacement during config loading cannot index the old project`, async () => {
    const h = harness(kind, { auto: true, holdConfig: true });
    h.start();
    h.version.resolve();
    await h.configEntered.promise;
    const next = { ...h.ctx, cwd: join(h.home, 'next-project') };
    h.start(next);
    const query = h.tool(undefined, next);
    h.config.resolve();
    await query;
    assert.equal(h.writers().length, 1);
    assert.ok(h.writers()[0].args.includes(next.cwd));
    assert.equal(h.notifications.length, 0);
    await h.shutdown();
  });

  test(`${kind}: queued initialization is cancelled before any subprocess starts`, async () => {
    const h = harness(kind, { auto: true });
    h.start();
    await h.shutdown();
    assert.equal(h.calls.length, 0);
    assert.equal(h.writes.length, 0);
  });

  test(`${kind}: automatic startup sync uses the index owner and settle sync remains single-flight`, async () => {
    const h = harness(kind, { indexed: true, auto: true });
    h.start();
    h.version.resolve();
    await h.tool();
    assert.equal(h.writers().length, 1);
    assert.ok(h.writers()[0].args.includes(h.root));
    h.hooks.agent_settled({}, h.ctx);
    // Drain the synchronous mock CLI completion through the tool's own await chain.
    await h.tool();
    assert.ok(h.writers().length >= 2);
    assert.ok(h.writers().every(call => call.args.includes(h.root)));
    await h.shutdown();
  });

  test(`${kind}: headless startup never spawns automatic index writers`, async () => {
    const h = harness(kind, { auto: true });
    h.ctx.hasUI = false;
    h.start();
    h.version.resolve();
    await h.tool();
    h.hooks.agent_settled({}, h.ctx);
    assert.equal(h.writers().length, 0);
    await h.shutdown();
  });

  test(`${kind}: missing CLI is checked once and reported without unhandled background failure`, async () => {
    const h = harness(kind, { missing: true });
    h.start();
    const query = h.tool();
    h.version.resolve();
    const result = await query;
    assert.match(result.content[0].text, /CLI not found/);
    assert.equal(h.versions().length, 1);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.writers().length, 0);
    await h.shutdown();
  });
}

test('zvec: a manual init arriving during gitignore setup still excludes automatic writers', async () => {
  const h = harness('zvec', { indexed: true, auto: true, holdGitignore: true });
  h.start();
  h.version.resolve();
  await h.gitignoreEntered.promise;
  const manual = h.commands['zvec-init'].handler('', h.ctx);
  h.gitignore.resolve();
  await manual;
  assert.equal(h.writers().length, 1);
  assert.ok(h.writers()[0].args.includes('--embedding'));
  await h.shutdown();
});

test('zvec: cancelling Windows discovery neither launches a fallback nor poisons its cache', async () => {
  const h = harness('zvec', { windows: true, holdDiscovery: true });
  h.start();
  await h.discoveryEntered.promise;
  const stopping = h.shutdown();
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.discovery.resolve();
  await stopping;
  assert.equal(h.calls.length, 1);
  h.start();
  h.version.resolve();
  await h.tool();
  assert.equal(h.calls.filter(call => call.args.includes('npm')).length, 2);
  assert.equal(h.calls.at(-1).command, 'node');
  await h.shutdown();
});

test('zvec: Windows discovery is asynchronous, cached, and preserves shell metacharacters', async () => {
  const h = harness('zvec', { windows: true });
  assert.equal(h.start(), undefined);
  assert.equal(h.calls.length, 0);
  const a = h.tool(), b = h.tool();
  await h.versionEntered.promise;
  h.version.resolve();
  await Promise.all([a, b]);
  assert.equal(h.calls.filter(call => call.args.includes('npm')).length, 1);
  const queries = h.calls.filter(call => call.args.includes('query'));
  assert.equal(queries.length, 2);
  assert.ok(queries.every(call => call.command === 'node' && call.args[0] === h.entry && call.args.includes('a|b')));
  await h.shutdown();
});

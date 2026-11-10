import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtension } from '../../../test/load-extension.mjs';

const providerPath = fileURLToPath(new URL('../src/provider.ts', import.meta.url));
const dataPath = fileURLToPath(new URL('../src/data.ts', import.meta.url));
const configPathSource = fileURLToPath(new URL('../src/config.ts', import.meta.url));

// Values returned by extension functions come from the loader's vm realm;
// JSON round-trip them so deepStrictEqual compares host-realm structures.
const host = (value) => JSON.parse(JSON.stringify(value));

function tempAgentDir() {
  return mkdtempSync(join(tmpdir(), 'pi-9router-test-'));
}

const CLAUDE = {
  id: 'kr/claude-sonnet-4.5',
  capabilities: { vision: true, reasoning: true, thinkingFormat: 'claude-budget', thinkingCanDisable: true, contextWindow: 200000, maxOutput: 64000 },
};

test('input types come from the router capabilities.vision flag', () => {
  const p = loadExtension(providerPath);
  assert.deepEqual(host(p.getInputTypes(CLAUDE)), ['text', 'image']);
  assert.deepEqual(host(p.getInputTypes({ id: 'x', capabilities: { vision: false } })), ['text']);
  assert.deepEqual(host(p.getInputTypes({ id: 'x' })), ['text']);
  assert.deepEqual(host(p.getInputTypes({ id: 'kr/claude-x' })), ['text', 'image']);
});

test('names fall back to a prettified id when the router sends none', () => {
  const p = loadExtension(providerPath);
  assert.equal(p.getModelName(CLAUDE), 'Claude Sonnet 4.5');
  assert.equal(p.getModelName({ id: 'oc/muse-spark-1.3-contributor-free' }), 'Muse Spark 1.3 Contributor Free');
  assert.equal(p.getModelName({ id: 'ollama/gpt-oss:120b' }), 'Gpt Oss:120b');
  assert.equal(p.getModelName({ id: 'x', name: 'Router Name' }), 'Router Name');
  assert.equal(p.getModelName({}), 'unknown');
});

test('context window and max tokens prefer top-level router values, then capabilities, then fallback', () => {
  const p = loadExtension(providerPath);
  assert.equal(p.getContextWindow(CLAUDE), 200000);
  assert.equal(p.getContextWindow({ id: 'x', context_length: 64000, capabilities: { contextWindow: 128000 } }), 64000);
  assert.equal(p.getContextWindow({ id: 'x', capabilities: { contextWindow: 128000 } }), 128000);
  assert.equal(p.getContextWindow({ id: 'x', context_window: 0 }), undefined);
  assert.equal(p.getContextWindow({ id: 'x' }, 99000), 99000);
  assert.equal(p.getMaxTokens(CLAUDE), 64000);
  assert.equal(p.getMaxTokens({ id: 'x', max_completion_tokens: 8192 }), 8192);
  assert.equal(p.getMaxTokens({ id: 'x', capabilities: { maxOutput: 4096 } }), 4096);
  assert.equal(p.getMaxTokens({ id: 'x' }, 4096), 4096);
});

test('reasoning prefers capabilities.reasoning over id heuristics', () => {
  const p = loadExtension(providerPath);
  assert.equal(p.getReasoning(CLAUDE), true);
  assert.equal(p.getReasoning({ id: 'kr/claude-sonnet-4.5' }), true);
  assert.equal(p.getReasoning({ id: 'omlx/Kokoro-82M-bf16', capabilities: { reasoning: false } }), false);
});

test('thinkingLevelMap follows the advertised thinking format', () => {
  const p = loadExtension(providerPath);
  assert.deepEqual(host(p.getThinkingLevelMap({ id: 'x', capabilities: { reasoning: true, thinkingFormat: 'deepseek' } })),
    { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' });
  assert.deepEqual(host(p.getThinkingLevelMap({ id: 'x', capabilities: { reasoning: true, thinkingCanDisable: false } })),
    { off: null, xhigh: 'xhigh', max: 'max' });
  assert.deepEqual(host(p.getThinkingLevelMap({ id: 'x', capabilities: { reasoning: true, thinkingFormat: 'claude-budget', thinkingCanDisable: true } })),
    { xhigh: 'xhigh', max: 'max' });
  assert.equal(p.getThinkingLevelMap({ id: 'x', capabilities: { reasoning: false } }), undefined);
});

test('combo opt-in honours the config switch and custom level map', () => {
  const p = loadExtension(providerPath);
  assert.deepEqual(host(p.resolveComboOptIn(true)), { reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } });
  assert.equal(p.resolveComboOptIn(false), null);
  assert.deepEqual(host(p.resolveComboOptIn({ thinkingLevelMap: { max: null } })), { reasoning: true, thinkingLevelMap: { max: null } });
});

test('config resolves from PI_CODING_AGENT_DIR with env fallback and tool toggles', () => {
  const dir = tempAgentDir();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const c = loadExtension(configPathSource);
    mkdirSync(join(dir, 'saifymatteo'), { recursive: true });
    writeFileSync(join(dir, 'saifymatteo', '9router.json'), JSON.stringify({
      baseUrl: 'https://router.example/v1/', apiKey: 'k1', tools: { transcribe: false },
    }));
    let cfg = host(c.loadConfig());
    assert.equal(cfg.baseUrl, 'https://router.example/v1');
    assert.equal(cfg.apiKey, 'k1');
    assert.equal(cfg.comboReasoning, true);
    assert.deepEqual(cfg.tools, { transcribe: false });

    delete process.env.ROUTER_API_BASE;
    process.env.ROUTER_API_KEY = 'env-key';
    writeFileSync(join(dir, 'saifymatteo', '9router.json'), JSON.stringify({ baseUrl: 'https://router.example/v1' }));
    cfg = host(c.loadConfig());
    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.tools, undefined);
    delete process.env.ROUTER_API_KEY;
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test('legacy haoyiyin config is copied once to the new location', () => {
  const dir = tempAgentDir();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const c = loadExtension(configPathSource);
    mkdirSync(join(dir, 'haoyiyin'), { recursive: true });
    writeFileSync(join(dir, 'haoyiyin', '9router.json'), JSON.stringify({ baseUrl: 'https://legacy.example/v1', apiKey: 'legacy' }));
    assert.equal(c.migrateLegacyConfig(), true);
    const migrated = JSON.parse(readFileSync(join(dir, 'saifymatteo', '9router.json'), 'utf8'));
    assert.equal(migrated.baseUrl, 'https://legacy.example/v1');
    assert.equal(migrated.apiKey, 'legacy');
    assert.equal(existsSync(join(dir, 'haoyiyin', '9router.json')), true);
    // Second run is a no-op, and the new file is never overwritten.
    writeFileSync(join(dir, 'saifymatteo', '9router.json'), JSON.stringify({ baseUrl: 'https://new.example/v1', apiKey: 'new' }));
    assert.equal(c.migrateLegacyConfig(), false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'saifymatteo', '9router.json'), 'utf8')).apiKey, 'new');
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test('model cache serves fresh entries, falls back to stale cache, and survives a missing router', async () => {
  const cacheHome = mkdtempSync(join(tmpdir(), 'pi-9router-cache-'));
  const dir = tempAgentDir();
  const prevCache = process.env.XDG_CACHE_HOME;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.XDG_CACHE_HOME = cacheHome;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // Credentials must resolve so the fetch path runs; without them the
    // provider registers empty and the cache file is left untouched.
    mkdirSync(join(dir, 'saifymatteo'), { recursive: true });
    writeFileSync(join(dir, 'saifymatteo', '9router.json'), JSON.stringify({ baseUrl: 'https://router.example/v1', apiKey: 'k' }));

    // Fresh cache: no fetch happens.
    mkdirSync(join(cacheHome, 'pi'), { recursive: true });
    writeFileSync(join(cacheHome, 'pi', '9router.json'), JSON.stringify({ ts: Date.now(), data: { data: [{ id: 'kr/glm-5' }] } }));
    const data = loadExtension(dataPath);
    assert.deepEqual(host(await data.getRouterModels()), [{ id: 'kr/glm-5' }]);

    // Stale cache + failing fetch: stale wins, warning printed.
    const lines = [];
    const staleData = loadExtension(dataPath, {}, { fetch: async () => { throw new Error('boom'); }, console: { warn: (m) => lines.push(String(m)), log: () => {} } });
    writeFileSync(join(cacheHome, 'pi', '9router.json'), JSON.stringify({ ts: 1, data: { data: [{ id: 'kr/stale' }] } }));
    assert.deepEqual(host(await staleData.getRouterModels()), [{ id: 'kr/stale' }]);
    assert.match(lines.join('\n'), /9router fetch failed, using stale cache: boom/);

    // No cache at all + failing fetch: empty list, still resolvable later.
    rmSync(join(cacheHome, 'pi', '9router.json'));
    const lines2 = [];
    const emptyData = loadExtension(dataPath, {}, { fetch: async () => { throw new Error('down'); }, console: { warn: (m) => lines2.push(String(m)), log: () => {} } });
    assert.deepEqual(host(await emptyData.getRouterModels()), []);
    assert.match(lines2.join('\n'), /9router unavailable: down/);

    // Successful fetch is parsed and cached.
    const liveData = loadExtension(dataPath, {}, {
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'kr/live', capabilities: { contextWindow: 5 } }] }) }),
      console: { warn: () => {}, log: () => {} },
    });
    assert.deepEqual(host(await liveData.getRouterModels()), [{ id: 'kr/live', capabilities: { contextWindow: 5 } }]);
    assert.deepEqual(JSON.parse(readFileSync(join(cacheHome, 'pi', '9router.json'), 'utf8')).data.data, [{ id: 'kr/live', capabilities: { contextWindow: 5 } }]);
  } finally {
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevCache;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
  }
});

test('registration maps router models into pi ProviderModelConfig entries', async () => {
  const calls = [];
  const pi = {
    registerProvider: (id, cfg) => calls.push(['register', id, cfg]),
    unregisterProvider: (id) => calls.push(['unregister', id]),
  };
  const dir = tempAgentDir();
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevCache = process.env.XDG_CACHE_HOME;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'pi-9router-reg-'));
  try {
    mkdirSync(join(dir, 'saifymatteo'), { recursive: true });
    writeFileSync(join(dir, 'saifymatteo', '9router.json'), JSON.stringify({ baseUrl: 'https://router.example/v1', apiKey: 'k' }));
    const p = loadExtension(providerPath, {}, {
      fetch: async () => ({ ok: true, json: async () => ({ data: [CLAUDE, { id: 'oc/jev-1.13-free', capabilities: { vision: false, reasoning: false, contextWindow: 200000, maxOutput: 32000, thinkingFormat: null } }] }) }),
      console: { warn: () => {}, log: () => {} },
    });
    await p.registerProvider(pi);
    const reg = calls.find(c => c[0] === 'register' && c[2].models.length);
    assert.ok(reg, 'provider registered with models');
    const [entry, oc] = host(reg[2].models);
    assert.equal(entry.id, 'kr/claude-sonnet-4.5');
    assert.equal(entry.name, 'Claude Sonnet 4.5');
    assert.equal(entry.reasoning, true);
    assert.deepEqual(entry.input, ['text', 'image']);
    assert.equal(entry.contextWindow, 200000);
    assert.equal(entry.maxTokens, 64000);
    assert.equal(entry.cost.input, 0);
    assert.equal(entry.compat.thinkingFormat, 'openai');
    assert.equal(oc.id, 'oc/jev-1.13-free');
    assert.deepEqual(oc.input, ['text']);
    assert.equal(oc.reasoning, false);
    assert.deepEqual(calls[0], ['unregister', '9router']);
  } finally {
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevCache;
  }
});

test('without credentials only the shell provider registers', async () => {
  const calls = [];
  const dir = tempAgentDir();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const p = loadExtension(providerPath, {}, { fetch: async () => { throw new Error('no network in test'); }, console: { warn: () => {}, log: () => {} } });
    await p.registerProvider({ registerProvider: (id, cfg) => calls.push([id, cfg]) });
    assert.equal(calls.length, 1);
    const [id, shell] = calls[0];
    assert.equal(id, '9router');
    assert.equal(shell.name, '9Router');
    assert.equal(shell.api, 'openai-completions');
    assert.deepEqual(host(shell.models), []);
    assert.equal(typeof shell.oauth.login, 'function');
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

// ABOUTME: Covers config locations, the one-time legacy move, $schema handling, and schema drift.
// ABOUTME: Uses temp homes so the real agent dir is never touched.
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CONFIG_ENV_OPTIONS, CONFIG_OPTIONS } from "../src/shared/config-options.ts";
import {
  ensureGlobalConfig,
  isAutoZedNestedEnabled,
  migrateLegacyGlobalConfig,
  readPiConfigStatusDisplay,
  resolveAgentDir,
  resolveLegacyPiGlobalConfigPath,
  resolveLegacyPiProjectConfigPath,
  resolvePiConfigEnv,
  resolvePiGlobalConfigPath,
  resolvePiProjectConfigPath,
  SCHEMA_URL,
  writePiConfigSettings,
} from "../src/shared/config.ts";

const schema = JSON.parse(await readFile(new URL("../schemas/pi-x-ide.schema.json", import.meta.url), "utf8")) as {
  $id: string;
  properties: Record<string, { default?: unknown; properties?: Record<string, unknown> }>;
};

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-x-ide-config-test-"));
}

const exists = (path: string) => stat(path).then(() => true, () => false);

void test("config lives at <agent-dir>/extensions and <project>/.pi/extensions", () => {
  assert.equal(resolvePiGlobalConfigPath("/h"), "/h/.pi/agent/extensions/pi-x-ide.json");
  assert.equal(resolvePiProjectConfigPath("/p"), "/p/.pi/extensions/pi-x-ide.json");
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    assert.equal(resolveAgentDir(), "/custom/agent");
    assert.equal(resolvePiGlobalConfigPath(), "/custom/agent/extensions/pi-x-ide.json");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

void test("moves the legacy global config once and removes the emptied folder", async () => {
  const home = await tempHome();
  const legacy = resolveLegacyPiGlobalConfigPath(home);
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, JSON.stringify({ status_display: "statusline" }));

  assert.equal(readPiConfigStatusDisplay({ home }), "statusline", "legacy file is read before the move");
  assert.deepEqual(migrateLegacyGlobalConfig(home), { from: legacy, to: resolvePiGlobalConfigPath(home) });
  assert.equal(await exists(legacy), false);
  assert.equal(await exists(dirname(legacy)), false);
  assert.equal(readPiConfigStatusDisplay({ home }), "statusline");
  assert.equal(migrateLegacyGlobalConfig(home), undefined, "second run is a no-op");
});

void test("legacy move keeps a non-empty folder (lock dir) and never overwrites the new file", async () => {
  const home = await tempHome();
  const legacy = resolveLegacyPiGlobalConfigPath(home);
  await mkdir(join(dirname(legacy), "lock"), { recursive: true });
  await writeFile(legacy, JSON.stringify({ status_display: "statusline" }));
  migrateLegacyGlobalConfig(home);
  assert.equal(await exists(join(dirname(legacy), "lock")), true);

  await writeFile(legacy, JSON.stringify({ status_display: "widget" }));
  assert.equal(migrateLegacyGlobalConfig(home), undefined);
  assert.equal(await exists(legacy), true, "old file is left alone when the new one exists");
  assert.equal(readPiConfigStatusDisplay({ home }), "statusline");
});

void test("legacy move through a symlink copies contents and removes only the link", async () => {
  const home = await tempHome();
  const target = join(home, "dotfiles", "pi-x-ide.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ env: { PI_X_IDE_ZED_DB: "/db" } }));
  const legacy = resolveLegacyPiGlobalConfigPath(home);
  await mkdir(dirname(legacy), { recursive: true });
  await symlink(target, legacy);

  migrateLegacyGlobalConfig(home);
  assert.equal(await exists(legacy), false);
  assert.equal(await readFile(target, "utf8"), JSON.stringify({ env: { PI_X_IDE_ZED_DB: "/db" } }));
  assert.equal((await lstat(resolvePiGlobalConfigPath(home))).isSymbolicLink(), false);
  assert.equal(await readFile(resolvePiGlobalConfigPath(home), "utf8"), await readFile(target, "utf8"));
  await assert.rejects(() => readlink(legacy));
});

void test("legacy project config is a read-only fallback", async () => {
  const home = await tempHome();
  const projectDir = join(home, "project");
  const legacy = resolveLegacyPiProjectConfigPath(projectDir);
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, JSON.stringify({ status_display: "statusline", env: { KEEP: "1" } }));

  assert.equal(readPiConfigStatusDisplay({ home, projectDir }), "statusline");
  assert.equal(resolvePiConfigEnv(process.env, { home, projectDir }).KEEP, "1");

  writePiConfigSettings({ autoInstall: false }, { scope: "project", projectDir, home });
  const saved = JSON.parse(await readFile(resolvePiProjectConfigPath(projectDir), "utf8")) as Record<string, unknown>;
  assert.equal(saved.status_display, "statusline", "first write is seeded from the legacy file");
  assert.equal(await exists(legacy), true, "files inside a repo are never moved");
});

void test("saving sets $schema only when absent", async () => {
  const home = await tempHome();
  const path = resolvePiGlobalConfigPath(home);
  assert.equal(SCHEMA_URL, "https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/pi-x-ide/schemas/pi-x-ide.schema.json");

  writePiConfigSettings({ display: "widget" }, { scope: "global", home });
  const fresh = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(Object.keys(fresh)[0], "$schema");
  assert.equal(fresh.$schema, SCHEMA_URL);

  await writeFile(path, JSON.stringify({ $schema: "./my.schema.json" }));
  writePiConfigSettings({ display: "statusline" }, { scope: "global", home });
  const custom = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(custom.$schema, "./my.schema.json");
  assert.equal(readPiConfigStatusDisplay({ home }), "statusline", "loader ignores $schema");
});

void test("hand-written schema matches config options", () => {
  assert.equal(schema.$id, SCHEMA_URL);
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    [...Object.keys(CONFIG_OPTIONS), "env", "$schema"].sort(),
  );
  for (const [name, option] of Object.entries(CONFIG_OPTIONS)) {
    assert.equal(schema.properties[name]?.default, option.default, `default for ${name}`);
  }
  assert.deepEqual(Object.keys(schema.properties.env?.properties ?? {}).sort(), Object.keys(CONFIG_ENV_OPTIONS).sort());
});

void test("zedNested defaults to manual; auto applies below $HOME but never at $HOME or the root", async () => {
  const home = await tempHome();
  const project = join(home, "work");
  assert.equal(isAutoZedNestedEnabled(project, home), false, "default manual");

  await mkdir(dirname(resolvePiProjectConfigPath(project)), { recursive: true });
  await writeFile(resolvePiProjectConfigPath(project), JSON.stringify({ zedNested: "auto" }));
  assert.equal(isAutoZedNestedEnabled(project, home), true, "project auto");

  await mkdir(dirname(resolvePiGlobalConfigPath(home)), { recursive: true });
  await writeFile(resolvePiGlobalConfigPath(home), JSON.stringify({ zedNested: "auto" }));
  assert.equal(isAutoZedNestedEnabled(home, home), false, "never at $HOME");
  assert.equal(isAutoZedNestedEnabled("/", home), false, "never at root");
  assert.equal(isAutoZedNestedEnabled(join(home, "other"), home), true, "global auto");

  await writeFile(resolvePiProjectConfigPath(project), JSON.stringify({ zedNested: "manual" }));
  assert.equal(isAutoZedNestedEnabled(project, home), false, "project overrides global");
});

void test("ensureGlobalConfig creates the global file once with $schema and defaults, never over an existing or legacy file", async () => {
  const home = await tempHome();
  const path = resolvePiGlobalConfigPath(home);
  ensureGlobalConfig(home);
  const created = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(created.$schema, SCHEMA_URL);
  for (const [name, option] of Object.entries(CONFIG_OPTIONS)) assert.equal(created[name], option.default, name);

  await writeFile(path, JSON.stringify({ status_display: "statusline" }));
  ensureGlobalConfig(home);
  assert.equal(readPiConfigStatusDisplay({ home }), "statusline", "existing file kept");

  const legacyHome = await tempHome();
  await mkdir(dirname(resolveLegacyPiGlobalConfigPath(legacyHome)), { recursive: true });
  await writeFile(resolveLegacyPiGlobalConfigPath(legacyHome), "{}");
  ensureGlobalConfig(legacyHome);
  assert.equal(await exists(resolvePiGlobalConfigPath(legacyHome)), false, "legacy file is moved, not shadowed");
});

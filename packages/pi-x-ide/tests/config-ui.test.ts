// ABOUTME: Covers /ide settings: scope picker, every simple field listed, global/project saves and cancel.
// ABOUTME: Drives the shared settings dialog through a mocked ctx.ui.custom with raw key input.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { IDE_SETTINGS_FIELDS, showIdeSettings } from "../src/pi/config-ui.ts";
import { createRuntime } from "../src/pi/state.ts";
import { CONFIG_OPTIONS } from "../src/shared/config-options.ts";
import {
  AUTO_INSTALL_ENV_KEY,
  readPiConfigStatusDisplay,
  readPiConfigZedNested,
  resolvePiGlobalConfigPath,
  resolvePiProjectConfigPath,
  SCHEMA_URL,
} from "../src/shared/config.ts";
import { applySettingsPatch, createSettingsDialog } from "../src/settings-dialog.ts";

const KEY = { down: "\u001b[B", enter: "\r", space: " ", esc: "\u001b", ctrlS: String.fromCharCode(19), x: "x" };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

async function withDirs(run: (paths: { home: string; projectDir: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-x-ide-config-ui-"));
  try {
    await run({ home: join(root, "home"), projectDir: join(root, "project") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Opens /ide settings, sends `keys`, and returns the last rendered frame and notifications. */
async function drive(projectDir: string, home: string, keys: string[]): Promise<{ frames: string[]; notes: string[] }> {
  const frames: string[] = [];
  const notes: string[] = [];
  const ctx = {
    cwd: projectDir,
    hasUI: true,
    mode: "tui",
    ui: {
      custom: (factory: (...args: unknown[]) => { render(w: number): string[]; handleInput(d: string): void }) =>
        new Promise((resolve) => {
          const component = factory({ requestRender: () => undefined }, theme, {}, resolve);
          for (const key of keys) {
            frames.push(component.render(400).join("\n"));
            component.handleInput(key);
          }
          frames.push(component.render(400).join("\n"));
          // Saving is async; a save calls done() before this fallback cancel fires.
          setTimeout(() => resolve(undefined), 20);
        }),
      notify: (message: string) => notes.push(message),
      setWidget: () => {},
      setStatus: () => {},
    },
  };
  await showIdeSettings(createRuntime(), ctx as never, { home });
  return { frames, notes };
}

void test("every simple CONFIG_OPTIONS key appears in /ide settings", () => {
  const keys = new Set(IDE_SETTINGS_FIELDS.map((field) => field.key));
  for (const name of Object.keys(CONFIG_OPTIONS)) assert.ok(keys.has(name), `${name} missing from /ide settings`);
  assert.ok(keys.has(`env.${AUTO_INSTALL_ENV_KEY}`));
});

void test("/ide settings opens a scope picker that lists Global and Project files", async () => {
  await withDirs(async ({ home, projectDir }) => {
    const { frames } = await drive(projectDir, home, []);
    assert.match(frames[0]!, /1\. Global/);
    assert.match(frames[0]!, /2\. Project/);
    assert.match(frames[0]!, /pi-x-ide\.json/);
  });
});

void test("Global scope lists Zed nested and saves a changed value with $schema", async () => {
  await withDirs(async ({ home, projectDir }) => {
    // Open Global, move to Zed nested, cycle manual -> auto, save.
    const { frames, notes } = await drive(projectDir, home, ["1", KEY.down, KEY.space, KEY.ctrlS]);
    assert.match(frames[1]!, /Zed nested\s+manual · default/);
    assert.match(frames[1]!, /Fix prompt/);
    const saved = JSON.parse(await readFile(resolvePiGlobalConfigPath(home), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved, { $schema: SCHEMA_URL, zedNested: "auto" });
    assert.equal(readPiConfigZedNested({ home }), "auto");
    assert.match(notes.at(-1)!, /Saved Global settings: .*pi-x-ide\.json · \/reload to apply/);
  });
});

void test("Project scope shows inherited global values and x removes the project override", async () => {
  await withDirs(async ({ home, projectDir }) => {
    const globalPath = resolvePiGlobalConfigPath(home);
    const projectPath = resolvePiProjectConfigPath(projectDir);
    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(globalPath, JSON.stringify({ status_display: "statusline" }));
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(projectPath, JSON.stringify({ status_display: "widget", env: { [AUTO_INSTALL_ENV_KEY]: "false" }, keep: 1 }));

    const { frames } = await drive(projectDir, home, ["2", KEY.down, KEY.down, KEY.x, KEY.ctrlS]);
    assert.match(frames[1]!, /Display\s+widget/);
    assert.match(frames[1]!, /AutoInstall\s+off/);
    const saved = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved, { $schema: SCHEMA_URL, status_display: "widget", keep: 1 }, "env emptied and removed; other keys kept");
    assert.equal(readPiConfigStatusDisplay({ projectDir, home }), "widget");
  });
});

void test("esc with unsaved changes warns first, and cancel writes nothing", async () => {
  await withDirs(async ({ home, projectDir }) => {
    const { frames, notes } = await drive(projectDir, home, ["1", KEY.space, KEY.esc, KEY.esc, KEY.esc]);
    assert.match(frames[3]!, /Unsaved changes/);
    await assert.rejects(readFile(resolvePiGlobalConfigPath(home), "utf8"), { code: "ENOENT" });
    assert.deepEqual(notes, []);
  });
});

void test("text fields edit newlines as \\n escapes and number fields validate", async () => {
  let saved: Record<string, unknown> | undefined;
  const scope = { id: "global" as const, path: "/tmp/x.json", read: () => ({}), save: (patch: Record<string, unknown>) => void (saved = patch) };
  const dialog = createSettingsDialog(
    {
      title: "t",
      scopes: [scope],
      fields: [
        { key: "a.text", label: "Text", description: "", type: "text", default: "x\ny" },
        { key: "n", label: "N", description: "", type: "number", default: 1, min: 1, max: 3, integer: true },
      ],
    },
    theme as never,
    () => {},
    () => {},
  );
  dialog.handleInput(KEY.enter);
  assert.match(dialog.render(80).join("\n"), /x\\ny▏/);
  for (const key of ["\u007f", "\u007f", "\u007f", "\u007f", "a", "\\", "n", "b", KEY.enter, KEY.down, KEY.enter, "\u007f", "9", KEY.enter]) dialog.handleInput(key);
  assert.match(dialog.render(80).join("\n"), /Maximum is 3/);
  for (const key of ["\u007f", "2", KEY.enter, KEY.ctrlS]) dialog.handleInput(key);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, { "a.text": "a\nb", n: 2 });
});

void test("applySettingsPatch sets dot paths and prunes emptied objects", () => {
  assert.deepEqual(applySettingsPatch({ env: { A: "1" }, k: 1 }, { "env.A": undefined, "tools.fetch": false }), {
    k: 1,
    tools: { fetch: false },
  });
});

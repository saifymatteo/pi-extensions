// ABOUTME: Verifies IDE context is sent as a visible model-context custom message.
// ABOUTME: Ensures the submitted user prompt remains unchanged and metadata omits selected source text.
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextHandlers, IDE_CONTEXT_MESSAGE_TYPE, setLatestSelection } from "../src/pi/context.ts";
import { createRuntime } from "../src/pi/state.ts";
import { toggleContextPaused } from "../src/pi/ui.ts";
import { formatEditorContextMessage } from "../src/shared/format.ts";
import type { EditorSelectionSnapshot } from "../src/shared/protocol.ts";

const snapshot: EditorSelectionSnapshot = {
  source: "vscode",
  filePath: "/repo/package.json",
  workspaceFolder: "/repo",
  ranges: [
    {
      text: '"description": "Pi extension package"',
      selection: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } },
    },
  ],
};

function createHarness() {
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const messages: unknown[] = [];
  const api = {
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => hooks.set(name, handler),
  } as unknown as ExtensionAPI;
  const runtime = createRuntime();
  const ctx = { cwd: "/repo", hasUI: false } as ExtensionContext;
  runtime.cwd = ctx.cwd;
  registerContextHandlers(api, runtime);
  return {
    hooks,
    messages,
    runtime,
    ctx,
    fire(name: string, event: unknown = {}) {
      return hooks.get(name)?.(event as never, ctx);
    },
  };
}

void test("adds concise IDE metadata as a visible custom message without changing the user prompt", () => {
  const h = createHarness();
  setLatestSelection(h.runtime, snapshot);
  const result = h.fire("before_agent_start", { messageType: "user", prompt: "Explain this" }) as {
    message: { customType: string; content: string; display: boolean };
  };
  assert.deepEqual(result, {
    message: {
      customType: IDE_CONTEXT_MESSAGE_TYPE,
      content: "### IDE Context\n- **IDE**: vscode\n- **File**: `package.json`\n- **Selection**: L2-L4",
      display: true,
    },
  });
  assert.equal(h.runtime.attachState, "sent");
  assert.equal(h.runtime.turnSelection, undefined);
  assert.deepEqual(h.runtime.pendingExtensionErrors, []);
});

void test("omits selection metadata for open-file-only context", () => {
  const h = createHarness();
  setLatestSelection(h.runtime, { ...snapshot, ranges: [] });
  const result = h.fire("before_agent_start", { messageType: "user", prompt: "Explain this" }) as {
    message: { content: string };
  };
  assert.equal(result.message.content, "### IDE Context\n- **IDE**: vscode\n- **File**: `package.json`");
  assert.doesNotMatch(result.message.content, /Selection|description|Pi extension/);
});

void test("does not add IDE context when attachment is disabled or no selection is available", () => {
  const h = createHarness();
  assert.equal(h.fire("before_agent_start", { messageType: "user", prompt: "ordinary prompt" }), undefined);
  setLatestSelection(h.runtime, snapshot);
  h.runtime.enabled = false;
  assert.equal(h.fire("before_agent_start", { messageType: "user", prompt: "ordinary prompt" }), undefined);
  assert.equal(h.runtime.attachState, "pending");
});

void test("does not duplicate attached context markers in the submitted prompt", () => {
  const h = createHarness();
  setLatestSelection(h.runtime, snapshot);
  assert.equal(
    h.fire("before_agent_start", {
      messageType: "user",
      prompt: `<system-reminder><selected-context>already attached ${snapshot.filePath}`,
    }),
    undefined,
  );
  assert.equal(h.runtime.attachState, "sent");
});

void test("context metadata formatter never includes selected source contents", () => {
  const formatted = formatEditorContextMessage(snapshot, { cwd: "/repo" });
  assert.match(formatted, /### IDE Context/);
  assert.match(formatted, /\*\*IDE\*\*: vscode/);
  assert.match(formatted, /\*\*File\*\*: `package\.json`/);
  assert.match(formatted, /\*\*Selection\*\*: L2-L4/);
  assert.doesNotMatch(formatted, /description|Pi extension package/);
});

void test("skips IDE context when a custom diagnostic message starts the run", () => {
  const h = createHarness();
  setLatestSelection(h.runtime, snapshot);
  assert.equal(
    h.fire("before_agent_start", {
      messageType: "custom",
      message: { content: [{ type: "text", text: "<!-- pi-x-ide/diagnostic-context -->\nfix it" }] },
    }),
    undefined,
  );
});

void test("paused IDE context stays paused across prompts until toggled back", () => {
  const h = createHarness();
  setLatestSelection(h.runtime, snapshot);
  assert.equal(toggleContextPaused(h.runtime), true);
  assert.equal(h.fire("before_agent_start", { messageType: "user", prompt: "one" }), undefined);
  assert.equal(h.fire("before_agent_start", { messageType: "user", prompt: "two" }), undefined);

  setLatestSelection(h.runtime, { ...snapshot, ranges: [] });
  assert.equal(h.runtime.contextPaused, true, "a new selection does not resume");
  assert.equal(h.fire("before_agent_start", { messageType: "user", prompt: "three" }), undefined);

  assert.equal(toggleContextPaused(h.runtime), false);
  assert.ok(h.fire("before_agent_start", { messageType: "user", prompt: "four" }), "latest selection attaches after resume");
  assert.equal(h.runtime.attachState, "sent");
});

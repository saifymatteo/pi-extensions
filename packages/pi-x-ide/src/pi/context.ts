// ABOUTME: Adds concise IDE file and selection metadata as a model-visible custom message.
// ABOUTME: Leaves the user's prompt unchanged so the agent can inspect source files directly.
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatEditorContextMessage } from "../shared/format.ts";
import { DIAGNOSTIC_CONTEXT_MARKER } from "./diagnostics.ts";
import type { EditorSelectionSnapshot } from "../shared/protocol.ts";
import { runPiBoundary } from "./safety.ts";
import type { PiIdeRuntime } from "./state.ts";
import { updateIdeUi } from "./ui.ts";

export { clearLatestSelection, setLatestSelection } from "./selection.ts";

export function registerContextHandlers(pi: ExtensionAPI, runtime: PiIdeRuntime): void {
  pi.on("before_agent_start", (event, ctx) =>
    runPiBoundary(
      "Pi before_agent_start",
      runtime,
      () => {
        runtime.ctx = ctx;
        // A skip holds the selection back from this prompt only; re-queue it for the next one.
        if (runtime.attachState === "skipped") {
          runtime.attachState = "pending";
          updateIdeUi(runtime, ctx);
          return;
        }
        if (!runtime.enabled || !runtime.latestSelection || runtime.attachState !== "pending") return;
        const snapshot = runtime.latestSelection;
        runtime.attachState = "sent";
        updateIdeUi(runtime, ctx);
        if (promptContainsContextMarker(runPromptText(event), snapshot)) return;

        return {
          message: {
            customType: IDE_CONTEXT_MESSAGE_TYPE,
            content: formatEditorContextMessage(snapshot, { cwd: ctx.cwd }),
            display: true,
          },
        };
      },
      ctx,
    ),
  );
}

export const IDE_CONTEXT_MESSAGE_TYPE = "pi-x-ide/context";

/** Text that started the run: the user prompt, or a custom message's text (e.g. a diagnostic fix request). */
function runPromptText(event: BeforeAgentStartEvent): string {
  if (event.messageType === "user") return event.prompt;
  const { content } = event.message;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function promptContainsContextMarker(prompt: string, snapshot: EditorSelectionSnapshot): boolean {
  return (
    prompt.includes(DIAGNOSTIC_CONTEXT_MARKER) ||
    (prompt.includes("<system-reminder><selected-context>") &&
      (prompt.includes(snapshot.filePath) || (!!snapshot.workspaceFolder && prompt.includes(snapshot.workspaceFolder))))
  );
}

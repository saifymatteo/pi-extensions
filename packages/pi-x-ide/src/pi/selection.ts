// ABOUTME: Updates Pi runtime selection snapshots used for attach and context injection.
// ABOUTME: Shared by the lightweight shell and heavy runtime without pulling TUI host packages.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshotKey } from "../shared/format.ts";
import type { EditorSelectionSnapshot } from "../shared/protocol.ts";
import type { PiIdeRuntime } from "./state.ts";
import { updateIdeUi } from "./ui.ts";

export function setLatestSelection(
  runtime: PiIdeRuntime,
  snapshot: EditorSelectionSnapshot,
  ctx?: ExtensionContext,
): void {
  const key = snapshotKey(snapshot);
  runtime.latestSelection = snapshot;
  if (runtime.latestSelectionKey !== key) {
    runtime.latestSelectionKey = key;
    runtime.attachState = "pending";
  }
  updateIdeUi(runtime, ctx);
}

export function clearLatestSelection(runtime: PiIdeRuntime, ctx?: ExtensionContext): void {
  runtime.latestSelection = undefined;
  runtime.latestSelectionKey = undefined;
  runtime.turnSelection = undefined;
  runtime.attachState = "idle";
  updateIdeUi(runtime, ctx);
}

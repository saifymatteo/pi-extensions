import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Keystrokes reach onTerminalInput before the editor applies them, so the
// editor is read once typing pauses. A hard kill loses at most this window.
const DEBOUNCE_MS = 300;
const STATUS_KEY = "draft";
// Ctrl+S is taken by Pi's pickers (sort, save model/thinking) and would warn at startup.
const SAVE_KEY = "alt+s";

export function draftPath(cwd: string): string {
	return join(getAgentDir(), "drafts", `${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.txt`);
}

// Sync and atomic: the file is tiny, writes stay ordered, and a kill mid-write
// leaves the previous draft rather than half of the new one.
export function saveDraft(file: string, text: string): void {
	if (!text.trim()) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, file);
}

export function loadDraft(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flush: (() => boolean) | undefined;

	// The footer mirrors the disk: "saved" while a draft file holds text, nothing when there is none.
	const status = (ctx: ExtensionContext, state: "saved" | "failed" | undefined) =>
		ctx.ui.setStatus(
			STATUS_KEY,
			state && ctx.ui.theme.fg(state === "saved" ? "dim" : "error", state === "saved" ? "✎ draft saved" : "✎ draft not saved"),
		);

	// Returns whether a draft is now on disk.
	const save = (ctx: ExtensionContext, file: string): boolean => {
		const text = ctx.ui.getEditorText();
		try {
			saveDraft(file, text);
		} catch (error) {
			status(ctx, "failed");
			ctx.ui.notify(`Draft not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		}
		const saved = !!text.trim();
		status(ctx, saved ? "saved" : undefined);
		return saved;
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const file = draftPath(ctx.cwd);
		const draft = loadDraft(file);
		if (draft.trim() && !ctx.ui.getEditorText().trim()) {
			ctx.ui.setEditorText(draft);
			ctx.ui.notify("Restored unsent draft", "info");
		}
		if (draft.trim()) status(ctx, "saved");
		flush = () => {
			clearTimeout(timer);
			timer = undefined;
			return save(ctx, file);
		};
		// Pi drops terminal-input listeners on reload and session switch; this re-adds them.
		ctx.ui.onTerminalInput(() => {
			clearTimeout(timer);
			timer = setTimeout(() => flush?.(), DEBOUNCE_MS);
			return undefined;
		});
	});

	pi.registerShortcut(SAVE_KEY, {
		description: "Save the prompt draft now",
		handler: (ctx) => {
			if (!flush) return;
			if (flush()) ctx.ui.notify("Draft saved", "info");
			else if (!ctx.ui.getEditorText().trim()) ctx.ui.notify("Nothing to save: the editor is empty", "info");
		},
	});

	pi.on("session_shutdown", () => {
		flush?.();
		flush = undefined;
	});
}

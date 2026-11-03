/**
 * Show Pi's native "Working" spinner, labelled with the extension currently
 * blocking, while before_agent_start hooks run (e.g. "⠙ Loading hindsight-coding-agents").
 *
 * Pi only raises its working indicator at turn_start, after every
 * before_agent_start handler has finished, so slow handlers (Hindsight's memory
 * recall can take ~20 s) leave the UI silent. Handlers run in extension load
 * order and live inside Pi's ExtensionRunner, so no event tells an extension
 * which one is running. This wraps ExtensionRunner.prototype.emitBeforeAgentStart
 * once per process: each handler is wrapped just long enough for Pi to snapshot
 * it, and the wrapper names its extension in the working message before it runs.
 *
 * The run is already active at that point, so setWorkingVisible(true) shows the
 * spinner immediately. The patch reads UI from the runner itself, so it survives
 * /reload without holding a stale extension ctx.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("settings.prestart-working.patched");
const EVENT = "before_agent_start";

type Handler = (...args: unknown[]) => unknown;
type Ext = { path: string; handlers: Map<string, Handler[]> };
type Runner = {
	extensions: Ext[];
	hasUI(): boolean;
	uiContext: { setWorkingMessage(m?: string): void; setWorkingVisible(v: boolean): void };
	emitBeforeAgentStart(...args: unknown[]): Promise<unknown>;
};

const names = new Map<string, string>();

/** Nearest package.json name (scope dropped), else the file name: "hindsight-coding-agents", "zvec". */
export function extensionLabel(path: string): string {
	const cached = names.get(path);
	if (cached) return cached;
	let label = basename(path, extname(path));
	if (label === "index" || label === "pi") {
		for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
			const pkg = join(dir, "package.json");
			if (!existsSync(pkg)) continue;
			try {
				const name = JSON.parse(readFileSync(pkg, "utf8")).name;
				if (typeof name === "string") label = name.replace(/^@[^/]+\//, "");
			} catch {}
			break;
		}
	}
	names.set(path, label);
	return label;
}

export default function () {
	const proto = (ExtensionRunner as unknown as { prototype: Runner & { [PATCHED]?: true } }).prototype;
	if (proto[PATCHED]) return;
	proto[PATCHED] = true;
	const original = proto.emitBeforeAgentStart;

	proto.emitBeforeAgentStart = function (this: Runner, ...args: unknown[]) {
		if (!this.hasUI()) return original.apply(this, args);
		const ui = this.uiContext;
		const swapped: [Ext, Handler[]][] = [];
		for (const ext of this.extensions) {
			const list = ext.handlers.get(EVENT);
			if (!list?.length) continue;
			const label = extensionLabel(ext.path);
			swapped.push([ext, list]);
			ext.handlers.set(
				EVENT,
				list.map((h) => (...a: unknown[]) => {
					ui.setWorkingMessage(`Loading ${label}`);
					return h(...a);
				}),
			);
		}
		ui.setWorkingVisible(true);
		// Pi snapshots the handler lists synchronously before its first await,
		// so the originals can go back right away (keeps pi.on() unsubscribe intact).
		const result = original.apply(this, args);
		for (const [ext, list] of swapped) ext.handlers.set(EVENT, list);
		return result.finally(() => ui.setWorkingMessage(undefined));
	};
}

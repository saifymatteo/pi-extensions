// Claude subscription usage (5h + 7d windows) in the footer.
//
// Data is free: pi-claude-code attaches Claude Code's rate_limit_event to
// every assistant message as a "claude-code.rate-limit" diagnostic, whose
// unifiedWindows carry utilization (0..1) and resetsAt (epoch seconds). The
// last value is cached on disk so a fresh session shows it before any turn.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATUS_KEY = "claude-usage";
const DIAGNOSTIC_TYPE = "claude-code.rate-limit";
const TICK_MS = 60_000; // countdown refresh only, no network

export interface Window {
	pct: number; // 0..100
	resetsAt: number; // epoch ms
}

export interface Usage {
	fiveHour?: Window;
	sevenDay?: Window;
	rejected?: boolean;
	overage?: boolean;
}

function cachePath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "state", "claude-usage.json");
}

// rate_limit_info from Claude Code stream-json.
export function fromRateLimit(info: any): Usage | undefined {
	const w = info?.unifiedWindows;
	if (!w || typeof w !== "object") return undefined;
	const win = (x: any): Window | undefined =>
		typeof x?.utilization === "number" && typeof x?.resetsAt === "number"
			? { pct: x.utilization * 100, resetsAt: x.resetsAt * 1000 }
			: undefined;
	return {
		fiveHour: win(w.five_hour),
		sevenDay: win(w.seven_day),
		rejected: info.status === "rejected",
		overage: info.isUsingOverage === true,
	};
}

export function formatLeft(ms: number): string {
	const mins = Math.max(0, Math.ceil(ms / 60_000));
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	return `${m}m`;
}

function part(label: string, w: Window | undefined, now: number): string {
	if (!w) return `${label} ?`;
	// A passed reset means the window rolled over since we last saw it.
	if (w.resetsAt <= now) return `${label} 0%`;
	return `${label} ${Math.round(w.pct)}% ↻${formatLeft(w.resetsAt - now)}`;
}

export function formatFooter(u: Usage, now = Date.now()): string {
	return `Claude ${part("5h", u.fiveHour, now)} · ${part("7d", u.sevenDay, now)}${u.overage ? " · overage" : ""}`;
}

function peak(u: Usage, now: number): number {
	const live = (w?: Window) => (w && w.resetsAt > now ? w.pct : 0);
	return Math.max(live(u.fiveHour), live(u.sevenDay));
}

export default function (pi: ExtensionAPI) {
	let usage: Usage | undefined;
	let ctx: ExtensionContext | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;

	function render() {
		if (!ctx || !usage) return;
		const now = Date.now();
		const text = formatFooter(usage, now);
		const p = peak(usage, now);
		const color = usage.rejected || usage.overage || p >= 90 ? "error" : p >= 75 ? "warning" : "dim";
		try {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
		} catch {
			/* replaced session */
		}
	}

	function update(next: Usage | undefined) {
		if (!next) return;
		usage = next;
		render();
		try {
			mkdirSync(dirname(cachePath()), { recursive: true });
			writeFileSync(cachePath(), JSON.stringify(next));
		} catch {
			/* cache is best-effort */
		}
	}

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		try {
			usage ??= JSON.parse(readFileSync(cachePath(), "utf8"));
		} catch {
			/* no cache yet */
		}
		render();
		if (!tick) {
			tick = setInterval(render, TICK_MS);
			tick.unref?.();
		}
	});

	pi.on("session_shutdown", async () => {
		if (tick) clearInterval(tick);
		tick = undefined;
		ctx = undefined;
	});

	pi.on("message_end", async (event) => {
		const msg: any = event.message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.diagnostics)) return;
		const diag = msg.diagnostics.findLast((d: any) => d?.type === DIAGNOSTIC_TYPE);
		if (diag) update(fromRateLimit(diag.details));
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFetch from "./fetch.ts";
import registerSearch from "./search.ts";
import registerTranscribe from "./transcribe.ts";
import { configPath, ensureConfig, loadConfig, migrateLegacyConfig, SCHEMA_URL } from "./config.ts";
import { readCache } from "./data.ts";
import { registerProvider, registerModels, isStaleCtxError } from "./provider.ts";

/** `/9router settings` fields; a comboReasoning thinking-level map stays JSON-only. Exported for tests. */
export const SETTINGS_FIELDS = [
	{ key: "baseUrl", label: "Base URL", type: "text", default: "", requiresReload: true,
		description: "OpenAI-compatible base URL, e.g. https://router.example/v1. Empty falls back to ROUTER_API_BASE." },
	{ key: "comboReasoning", label: "Combo reasoning", type: "boolean", default: true, requiresReload: true,
		fromFile: (raw: unknown) => (typeof raw === "boolean" ? raw : raw && typeof raw === "object" ? true : undefined),
		description: "Reasoning for combo models. Saving here replaces a custom thinkingLevelMap object with on/off." },
	...(["fetch", "search", "transcribe"] as const).map((tool) => ({
		key: `tools.${tool}`, label: `Tool: ${tool}`, type: "boolean" as const, default: true, requiresReload: true,
		description: `Register the bundled ${tool} tool (needs a base URL and a 9router login).`,
	})),
] as const;

export default async function (pi: ExtensionAPI): Promise<void> {
	pi.registerCommand("9router", {
		description: "9Router: /9router settings edits 9router.json",
		getArgumentCompletions: (prefix: string) =>
			"settings".startsWith(prefix) ? [{ value: "settings", label: "settings", description: "Edit global settings" }] : null,
		handler: async (args, ctx) => {
			if (args.trim() !== "settings") {
				ctx.ui.notify("Usage: /9router settings", "warning");
				return;
			}
			const { jsonFileScope, openSettingsDialog } = await import("./settings-dialog.ts");
			await openSettingsDialog(ctx, {
				title: "9Router settings",
				scopes: [jsonFileScope("global", configPath(), SCHEMA_URL)],
				fields: [...SETTINGS_FIELDS],
				footnote: "The API key is the 9router login in auth.json (/login). comboReasoning.thinkingLevelMap stays JSON-only.",
			});
		},
	});
	migrateLegacyConfig();
	ensureConfig();
	const cfg = loadConfig();
	// The bundled fetch/search/transcribe tools call the router API, so they
	// only register when a base URL and a credential are both available (the
	// credential comes from auth.json / ROUTER_API_KEY at load time; logging in
	// mid-session enables them on the next launch). Per-tool switches from
	// 9router.json (`"tools": {"fetch": false}`) disable individually.
	const toolsReady = Boolean(cfg.baseUrl && cfg.apiKey);
	if (toolsReady && cfg.tools?.fetch !== false) registerFetch(pi);
	if (toolsReady && cfg.tools?.search !== false) registerSearch(pi);
	if (toolsReady && cfg.tools?.transcribe !== false) registerTranscribe(pi);

	// Never block Pi's startup on the router: register from the cache (any
	// age, or empty on the very first run) now, then refresh in the background.
	registerModels(pi, readCache(true) ?? []);

	let refreshing = false;
	let closed = false;
	const refresh = async () => {
		// Models refresh by unregister+register; the /v1/models cache TTL is
		// 30m so refetch happens naturally. Overlap guard avoids re-entrancy.
		if (closed || refreshing) return;
		refreshing = true;
		try {
			await registerProvider(pi);
		} catch (err) {
			// The captured `pi` goes stale after session replacement or
			// extension reload, and pi's assertActive() throw must never
			// escape this callback — it would crash the whole process as an
			// uncaughtException. The new session's extension instance
			// re-registers the provider itself, so stop refreshing for good.
			if (isStaleCtxError(err)) {
				closed = true;
				clearInterval(timer);
			}
			// Any other error (network hiccup, bad upstream payload) is
			// swallowed: the next tick retries.
		} finally {
			refreshing = false;
		}
	};
	const timer = setInterval(refresh, 30 * 60 * 1000);
	// A fresh cache already registered the current models; otherwise fetch now,
	// without awaiting.
	if (cfg.apiKey && !readCache()) void refresh();
	if (typeof (timer as { unref?: () => void }).unref === "function") {
		(timer as { unref: () => void }).unref();
	}
	pi.on("session_shutdown", () => {
		closed = true;
		clearInterval(timer);
	});
}

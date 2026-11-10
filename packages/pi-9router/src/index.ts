import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFetch from "./fetch.ts";
import registerSearch from "./search.ts";
import registerTranscribe from "./transcribe.ts";
import { loadConfig, migrateLegacyConfig } from "./config.ts";
import { registerProvider, isStaleCtxError } from "./provider.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	migrateLegacyConfig();
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

	await registerProvider(pi);

	let refreshing = false;
	let closed = false;
	const timer = setInterval(
		async () => {
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
				// re-registers the provider itself, so stop this timer for good.
				if (isStaleCtxError(err)) {
					closed = true;
					clearInterval(timer);
				}
				// Any other error (network hiccup, bad upstream payload) is
				// swallowed: the next tick retries.
			} finally {
				refreshing = false;
			}
		},
		30 * 60 * 1000,
	);
	if (typeof (timer as { unref?: () => void }).unref === "function") {
		(timer as { unref: () => void }).unref();
	}
	pi.on("session_shutdown", () => {
		closed = true;
		clearInterval(timer);
	});
}

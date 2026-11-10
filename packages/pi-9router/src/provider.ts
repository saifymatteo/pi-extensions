/**
 * provider.ts — 9Router model provider
 *
 * Registers the "9router" provider in Pi, driven entirely by the router's own
 * `/v1/models` endpoint (see ./data.ts). Falls back to an empty model list if
 * the API key is unset (so /login can configure it and re-register once a key
 * is saved).
 *
 * Config (base URL + key, with env fallback) is owned by ./config.ts.
 *
 * Derived from @xynogen/pix-9router (MIT) via @haoyiyin/9router (MIT), with the
 * external catalogs (models.dev, modelgrep, opencode zen) removed: the router
 * advertises capabilities for every model it lists.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { RouterModel } from "./data.ts";
import { getRouterModels } from "./data.ts";
import { loadConfig, saveConfig, seedAuthCredential, type RouterConfig } from "./config.ts";

/** The chat member of pi's ProviderModelConfig union — the only kind we register. */
type ProviderChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

// ponytail: pi's ProviderModelConfig requires both numbers, so a model the
// router leaves blank still needs a value. Used only when nothing is advertised.
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

// Fallback pattern-based detection for routers whose /v1/models does not
// advertise capabilities.vision (our instance always does).
const IMAGE_CAPABLE_PATTERNS = [/claude/i, /gpt-5/i, /gpt-4/i, /kimi-k2/i, /hy3/i];

export function getInputTypes(model: RouterModel): ("text" | "image")[] {
	const vision = model.capabilities?.vision;
	if (typeof vision === "boolean") return vision ? ["text", "image"] : ["text"];
	const id = model.id ?? "";
	if (IMAGE_CAPABLE_PATTERNS.some((p) => p.test(id))) return ["text", "image"];
	return ["text"];
}

/** "kr/claude-sonnet-4.5" -> "Claude Sonnet 4.5" (display only; ids stay intact). */
export function prettyModelName(id: string): string {
	const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	const pretty = bare
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
	return pretty || id;
}

export function getModelName(model: RouterModel): string {
	return model.name || prettyModelName(model.id ?? "") || "unknown";
}

/** First positive finite number. 0/null/NaN are "not advertised", not a real limit. */
function firstPositive(...values: unknown[]): number | undefined {
	for (const v of values) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	}
	return undefined;
}

/**
 * Context window straight from the router. `fallback` applies only when the
 * router advertises nothing — never ahead of an API value.
 */
export function getContextWindow(model: RouterModel, fallback?: number): number | undefined {
	return firstPositive(
		model.context_window,
		model.contextWindow,
		model.context_length,
		model.capabilities?.contextWindow,
		fallback,
	);
}

/** Max output straight from the router. `fallback` only when nothing is advertised. */
export function getMaxTokens(model: RouterModel, fallback?: number): number | undefined {
	return firstPositive(
		model.max_tokens,
		model.maxTokens,
		model.max_completion_tokens,
		model.capabilities?.maxOutput,
		model.capabilities?.max_output,
		fallback,
	);
}

export function getReasoning(model: RouterModel): boolean {
	if (typeof model.capabilities?.reasoning === "boolean") return model.capabilities.reasoning;
	return /reasoner|thinking|xhigh|high|max|pro|codex|opus|sonnet/i.test(model.id ?? "");
}

// pi understands these thinkingFormats; the router backend declares openai/deepseek
// (and occasionally minimax/gemini-level, which pi cannot natively drive). Map the
// known ones and fall back to openai for anything unknown/minimax/gemini-level.
const PI_THINKING_FORMAT: Record<string, "openai" | "deepseek"> = {
	openai: "openai",
	deepseek: "deepseek",
};

function getThinkingFormat(model: RouterModel): "openai" | "deepseek" {
	return PI_THINKING_FORMAT[model.capabilities?.thinkingFormat ?? ""] ?? "openai";
}

/**
 * Derive pi's thinkingLevelMap from the router's advertised capabilities.
 * DeepSeek exposes low/high/max (mirrors pi's own deepseek catalog); openai-style
 * models expose off..max, hiding `off` when thinking cannot be disabled. No map
 * is returned when the backend does not declare reasoning.
 */
export function getThinkingLevelMap(
	model: RouterModel,
): ProviderChatModelConfig["thinkingLevelMap"] | undefined {
	const cap = model.capabilities;
	if (cap?.reasoning !== true) return undefined;
	if (cap.thinkingFormat === "deepseek") {
		return { minimal: null, low: "low", medium: null, high: "high", max: "max" };
	}
	// openai-style: reasoning_effort takes the level name directly. Unlock
	// xhigh/max, and hide off when thinking cannot be disabled.
	return {
		...(cap.thinkingCanDisable === false ? { off: null } : {}),
		xhigh: "xhigh",
		max: "max",
	};
}

/**
 * Combo models (`owned_by === "combo"`) carry no capabilities from the router, so
 * their reasoning is decided by `comboReasoning` in 9router.json: default `true`
 * (off..max, the same range named reasoning models get), `false` disables, or an
 * object with a custom `thinkingLevelMap` to override the range.
 *
 * pi only surfaces `xhigh`/`max` when `thinkingLevelMap` maps them (see pi's
 * getSupportedThinkingLevels), so the default carries an explicit map — without
 * it combo models would be stuck at `high`.
 */
const DEFAULT_COMBO_THINKING_LEVEL_MAP: ProviderChatModelConfig["thinkingLevelMap"] = {
	xhigh: "xhigh",
	max: "max",
};

export function resolveComboOptIn(
	comboReasoning: RouterConfig["comboReasoning"],
): { reasoning: true; thinkingLevelMap: ProviderChatModelConfig["thinkingLevelMap"] } | null {
	if (!comboReasoning) return null;
	const custom =
		comboReasoning === true
			? undefined
			: (comboReasoning.thinkingLevelMap as ProviderChatModelConfig["thinkingLevelMap"] | undefined);
	return {
		reasoning: true,
		thinkingLevelMap: custom ?? DEFAULT_COMBO_THINKING_LEVEL_MAP,
	};
}

/**
 * True if `err` is pi's stale-extension-ctx error, thrown when a captured
 * `pi`/command ctx is used after session replacement (newSession / fork /
 * switchSession) or extension reload. A stale instance can never recover —
 * the new session's extension instance re-registers everything itself.
 */
export function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && /stale after session replacement|ctx is stale/.test(err.message);
}

// Login flow: collect base URL + API key, persist to config, then re-register
// so the model list and base URL take effect. The key is carried as the OAuth
// credential (getApiKey); no separate apiKey is set on the provider, so /login
// shows exactly one 9router entry instead of an api_key + oauth pair.
function makeOAuth(pi: ExtensionAPI) {
	return {
		name: "9Router",
		login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
			const current = loadConfig();
			const baseUrl = await callbacks.onPrompt({
				message: "9Router base URL",
				placeholder: current.baseUrl || "https://your-router.example.com",
			});
			if (baseUrl === undefined) throw new Error("9Router login cancelled");
			const trimmedBase = baseUrl.trim();
			const normalizedBase = trimmedBase.endsWith("/")
				? trimmedBase.slice(0, -1)
				: trimmedBase;

			const apiKey = await callbacks.onPrompt({
				message: "9Router API key",
				placeholder: "sk-...",
			});
			if (apiKey === undefined) throw new Error("9Router login cancelled");
			const trimmedKey = apiKey.trim();
			if (!trimmedKey) throw new Error("9Router API key is required");

			saveConfig({
				baseUrl: normalizedBase,
				apiKey: "",
				comboReasoning: current.comboReasoning,
				tools: current.tools,
			});

			// The key lives in auth.json as the login credential; pi persists the
			// returned value after login resolves. Seed it up front (force: an
			// existing entry may hold a revoked key) so the immediate re-register
			// can already fetch models.
			seedAuthCredential(trimmedKey, { force: true });
			await registerProvider(pi);

			return { refresh: trimmedKey, access: trimmedKey, expires: Number.MAX_SAFE_INTEGER };
		},
		refreshToken: async (cred: OAuthCredentials): Promise<OAuthCredentials> => cred,
		getApiKey: (cred: OAuthCredentials): string => cred.access,
	};
}

export async function registerProvider(pi: ExtensionAPI): Promise<void> {
	const cfg = loadConfig();
	const oauth = makeOAuth(pi);

	if (!cfg.apiKey) {
		// Register shell provider so /login can configure it; no models yet.
		pi.registerProvider("9router", {
			name: "9Router",
			api: "openai-completions",
			models: [],
			oauth,
		});
		return;
	}

	const models = await getRouterModels();

	// Upstream moved OpenAI `compat` settings from the provider level to the
	// per-model level (ProviderModelConfig.compat). Apply the same shim to every
	// registered model.
	const COMPAT = {
		supportsDeveloperRole: false,
		supportsUsageInStreaming: false,
		maxTokensField: "max_tokens",
	} as const;

	const seen = new Set<string>();
	const out: ProviderChatModelConfig[] = [];

	for (const model of models) {
		const id = model.id ?? "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const thinkingFormat = getThinkingFormat(model);
		const comboOptIn = model.owned_by === "combo" ? resolveComboOptIn(cfg.comboReasoning) : null;
		out.push({
			id,
			name: getModelName(model),
			reasoning: comboOptIn ? comboOptIn.reasoning : getReasoning(model),
			input: getInputTypes(model),
			cost: ZERO_COST,
			contextWindow: getContextWindow(model, FALLBACK_CONTEXT_WINDOW)!,
			maxTokens: getMaxTokens(model, FALLBACK_MAX_TOKENS)!,
			thinkingLevelMap: comboOptIn ? comboOptIn.thinkingLevelMap : getThinkingLevelMap(model),
			compat: {
				...COMPAT,
				supportsReasoningEffort: true,
				thinkingFormat,
				...(thinkingFormat === "deepseek"
					? { requiresReasoningContentOnAssistantMessages: true }
					: {}),
			},
		});
	}

	if (typeof (pi as { unregisterProvider?: unknown }).unregisterProvider === "function") {
		pi.unregisterProvider("9router");
	}
	pi.registerProvider("9router", {
		name: "9Router",
		baseUrl: cfg.baseUrl,
		api: "openai-completions",
		headers: { "User-Agent": "pi-coding-agent" },
		models: out,
		oauth,
	});
}

export default registerProvider;

/**
 * data.ts — 9Router data layer
 *
 * Model discovery comes from the router's own `/v1/models` endpoint — the
 * single source of truth. No external catalogs (modelgrep, models.dev,
 * opencode zen) are consulted; the router advertises capabilities
 * (vision/reasoning/thinking/context/maxOutput) for every model it lists.
 *
 * Models are cached for 30 minutes at ~/.cache/pi/9router.json. A failed
 * refresh falls back to the stale cache; with no cache at all the provider
 * registers an empty list until the next successful fetch.
 *
 * Config (base URL + key, with env fallback) is owned by ./config.ts.
 */

import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterModel {
	id?: string;
	name?: string;
	context_window?: number;
	contextWindow?: number;
	/** 9router also advertises the OpenAI-style top-level aliases */
	context_length?: number;
	max_tokens?: number;
	maxTokens?: number;
	max_completion_tokens?: number;
	owned_by?: string;
	/** 9router v1 API nests these inside capabilities */
	capabilities?: {
		contextWindow?: number;
		maxOutput?: number;
		max_output?: number;
		reasoning?: boolean;
		vision?: boolean;
		thinkingFormat?: string;
		thinkingCanDisable?: boolean;
		thinkingRange?: unknown;
		[key: string]: unknown;
	};
}

interface RouterModelsResponse {
	data?: RouterModel[];
}

// ── Resolved config helpers ───────────────────────────────────────────────────

export function routerBaseUrl(): string {
	return loadConfig().baseUrl;
}

export function routerApiKey(): string {
	return loadConfig().apiKey;
}

// ── Router models ─────────────────────────────────────────────────────────────

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export function cacheDir(): string {
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
}

export function cachePath(): string {
	return join(cacheDir(), "9router.json");
}

function parseModels(raw: unknown): RouterModel[] {
	const data = (raw as RouterModelsResponse | undefined)?.data;
	return Array.isArray(data) ? data.filter((m) => Boolean(m.id)) : [];
}

function readCache(ignoreTtl = false): RouterModel[] | undefined {
	try {
		if (!existsSync(cachePath())) return undefined;
		const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as {
			ts?: number;
			data?: unknown;
		};
		if (typeof parsed.ts !== "number") return undefined;
		if (!ignoreTtl && Date.now() - parsed.ts >= TTL_MS) return undefined;
		return parseModels(parsed.data);
	} catch {
		return undefined;
	}
}

let inflight: Promise<RouterModel[]> | null = null;

async function fetchModels(): Promise<RouterModel[]> {
	const base = routerBaseUrl().replace(/\/+$/, "");
	const key = routerApiKey();
	const res = await fetch(`${base}/models`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
	return parseModels(await res.json());
}

/**
 * Live router models, cached 30 minutes. On fetch failure the stale cache is
 * used when present (warned); with neither, an empty list is returned so the
 * provider still registers and a later refresh can populate it.
 */
export async function getRouterModels(): Promise<RouterModel[]> {
	if (inflight) return inflight;
	inflight = (async () => {
		// Without a base URL or key there is nothing to fetch: register empty
		// (the login flow re-registers) and leave any cache file untouched.
		if (!routerBaseUrl() || !routerApiKey()) {
			return [];
		}
		const fresh = readCache();
		if (fresh) {
			return fresh;
		}
		try {
			const models = await fetchModels();
			try {
				mkdirSync(cacheDir(), { recursive: true });
				writeFileSync(cachePath(), JSON.stringify({ ts: Date.now(), data: { data: models } }));
			} catch {
				// cache write failure is non-fatal
			}
			return models;
		} catch (error) {
			const stale = readCache(true);
			const msg = (error as Error)?.message ?? String(error);
			if (stale) {
				console.warn(`9router fetch failed, using stale cache: ${msg}`);
				return stale;
			}
			console.warn(`9router unavailable: ${msg}`);
			return [];
		}
	})();
	try {
		return await inflight;
	} finally {
		inflight = null;
	}
}

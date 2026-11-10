import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_BASE = "";

/** Tool toggles in 9router.json — each defaults to on; set false to disable. */
export interface ToolToggles {
	fetch?: boolean;
	search?: boolean;
	transcribe?: boolean;
}

export interface RouterConfig {
	baseUrl: string;
	apiKey: string;
	/**
	 * Force reasoning:true onto combo models (`owned_by === "combo"`).
	 * Combo models carry no capabilities from the router, so this switch decides
	 * their reasoning status. Defaults to `true` (combo routes are assumed to hit
	 * thinking-capable upstreams) with the full off..max range; set `false` to opt
	 * out, or pass a custom `thinkingLevelMap` to override the range.
	 */
	comboReasoning?: boolean | { thinkingLevelMap?: Record<string, string | null> };
	/** Per-tool switches for the bundled fetch/search/transcribe tools. */
	tools?: ToolToggles;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), "saifymatteo", "9router.json");
}

/** Config location written by the retired @haoyiyin/9router package. */
export function legacyConfigPath(): string {
	return join(agentDir(), "haoyiyin", "9router.json");
}

/**
 * One-time migration from the retired @haoyiyin/9router config location: if our
 * config does not exist yet and the legacy one does, copy it (mode 0600). The
 * legacy file is never deleted or read as a config source afterwards.
 */
export function migrateLegacyConfig(): boolean {
	const target = configPath();
	if (existsSync(target)) return false;
	const legacy = legacyConfigPath();
	if (!existsSync(legacy)) return false;
	try {
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(legacy, target);
		chmodSync(target, 0o600);
		return true;
	} catch {
		return false;
	}
}

export function loadConfig(): RouterConfig {
	const path = configPath();
	let fileBase: string | undefined;
	let fileKey: string | undefined;
	let comboReasoning: RouterConfig["comboReasoning"] | undefined;
	let tools: ToolToggles | undefined;

	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") {
				if (typeof parsed.baseUrl === "string") fileBase = parsed.baseUrl;
				if (typeof parsed.apiKey === "string") fileKey = parsed.apiKey;
				if (
					typeof parsed.comboReasoning === "boolean" ||
					(parsed.comboReasoning && typeof parsed.comboReasoning === "object")
				) {
					comboReasoning = parsed.comboReasoning;
				}
				if (parsed.tools && typeof parsed.tools === "object") tools = parsed.tools;
			}
		} catch {
			// tolerate malformed config -> fall back to env/defaults
		}
	}

	let baseUrl = fileBase ?? process.env.ROUTER_API_BASE ?? DEFAULT_BASE;
	if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);

	const apiKey = fileKey ?? process.env.ROUTER_API_KEY ?? "";

	return { baseUrl, apiKey, comboReasoning: comboReasoning ?? true, tools };
}

export function saveConfig(cfg: RouterConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best-effort enforcement on existing files
	}
}

import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
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
	/**
	 * Resolved at read time, never persisted: the API key lives in auth.json as
	 * the "9router" login credential (written by /login or migration), with
	 * ROUTER_API_KEY as an explicit override. saveConfig strips this field.
	 */
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

/**
 * Package config: <agent-dir>/extensions/9router.json — the same directory as
 * every other package's settings (typically a symlink into the user's
 * dotfiles), so the base URL and toggles are versioned while the key stays in
 * auth.json.
 */
export function configPath(): string {
	return join(agentDir(), "extensions", "9router.json");
}

/** Config location written by the retired @haoyiyin/9router package. */
export function legacyConfigPath(): string {
	return join(agentDir(), "haoyiyin", "9router.json");
}

/** Never-shipped pre-release location used by early 0.1.0 dev builds. */
function intermediateConfigPath(): string {
	return join(agentDir(), "saifymatteo", "9router.json");
}

function authPath(): string {
	return join(agentDir(), "auth.json");
}

/** The 9router login credential from auth.json, or undefined. */
function readAuthCredential(): { access?: string; key?: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(authPath(), "utf8"));
		const cred = parsed?.["9router"];
		return cred && typeof cred === "object" ? cred : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Write the credential into auth.json. With `force` (the /login flow) an
 * existing 9router entry is overwritten; otherwise (migration) a live entry is
 * never clobbered.
 */
export function seedAuthCredential(apiKey: string, opts: { force?: boolean } = {}): void {
	try {
		let parsed: Record<string, unknown> = {};
		try {
			parsed = JSON.parse(readFileSync(authPath(), "utf8")) ?? {};
		} catch {
			// no or malformed auth.json — start a fresh object, keeping nothing
		}
		if (parsed["9router"] && !opts.force) return;
		parsed["9router"] = {
			type: "oauth",
			access: apiKey,
			refresh: apiKey,
			expires: Number.MAX_SAFE_INTEGER,
		};
		writeFileSync(authPath(), JSON.stringify(parsed, null, 2), { mode: 0o600 });
		try {
			chmodSync(authPath(), 0o600);
		} catch {
			// best-effort enforcement on existing files
		}
	} catch {
		// seeding is best-effort; /login remains the fallback
	}
}

/**
 * One-time migration from the retired @haoyiyin/9router config (and the
 * never-shipped saifymatteo/ intermediate): write the new secret-free config
 * to extensions/9router.json, move the API key into the auth.json credential,
 * then remove the intermediate file. The @haoyiyin file is retained —
 * published pi-vision releases still read it until their own update ships.
 */
export function migrateLegacyConfig(): boolean {
	const target = configPath();
	if (existsSync(target)) return false;
	const intermediate = intermediateConfigPath();
	const source = existsSync(intermediate)
		? intermediate
		: existsSync(legacyConfigPath())
			? legacyConfigPath()
			: "";
	if (!source) return false;
	try {
		const parsed = JSON.parse(readFileSync(source, "utf8"));
		if (!parsed || typeof parsed !== "object") return false;
		const cfg: RouterConfig = {
			baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
			apiKey: "",
			comboReasoning:
				typeof parsed.comboReasoning === "boolean" ||
				(parsed.comboReasoning && typeof parsed.comboReasoning === "object")
					? parsed.comboReasoning
					: true,
			tools: parsed.tools && typeof parsed.tools === "object" ? parsed.tools : undefined,
		};
		saveConfig(cfg);
		if (typeof parsed.apiKey === "string" && parsed.apiKey) {
			seedAuthCredential(parsed.apiKey);
		}
		if (source === intermediate) {
			try {
				rmSync(intermediate);
			} catch {
				// best effort — a leftover only pollutes a directory
			}
		}
		return true;
	} catch {
		return false;
	}
}

export function loadConfig(): RouterConfig {
	let fileBase: string | undefined;
	let comboReasoning: RouterConfig["comboReasoning"] | undefined;
	let tools: ToolToggles | undefined;

	const path = configPath();
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") {
				if (typeof parsed.baseUrl === "string") fileBase = parsed.baseUrl;
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

	const authCred = readAuthCredential();
	const apiKey = process.env.ROUTER_API_KEY || authCred?.access || authCred?.key || "";

	return { baseUrl, apiKey, comboReasoning: comboReasoning ?? true, tools };
}

/** The persisted config shape — everything except the resolved API key. */
function persisted(cfg: RouterConfig): Record<string, unknown> {
	const out: Record<string, unknown> = { baseUrl: cfg.baseUrl };
	out.comboReasoning = cfg.comboReasoning ?? true;
	if (cfg.tools !== undefined) out.tools = cfg.tools;
	return out;
}

export function saveConfig(cfg: RouterConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(persisted(cfg), null, 2), { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// best-effort enforcement on existing files
	}
}

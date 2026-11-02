/**
 * Load <PI_CODING_AGENT_DIR>/.env into process.env so bash-tool subprocesses
 * inherit the vars (verified: extension-set process.env reaches bash).
 * No tool registration -> no conflict with extensions that override `bash`
 * (e.g. pi-tool-display). Resolution: $PI_CODING_AGENT_DIR/.env first,
 * fallback ~/.pi/agent/.env.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

// Expand $NAME and ${NAME}; leave missing or circular references literal.
function expandValue(
	value: string,
	envFile: Record<string, string>,
	hostEnv: NodeJS.ProcessEnv,
	resolving = new Set<string>(),
): string {
	return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, bare, braced) => {
		const name = braced || bare;
		if (hostEnv[name] !== undefined) return hostEnv[name];
		if (!(name in envFile) || resolving.has(name)) return token;
		const nextResolving = new Set(resolving).add(name);
		return expandValue(envFile[name], envFile, hostEnv, nextResolving);
	});
}

function parseDotEnv(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return out;
	}
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

export default function () {
	const envPath = join(
		process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent"),
		".env",
	);
	const envFile = parseDotEnv(envPath);
	for (const [k, v] of Object.entries(envFile)) {
		// Fill gap only; never clobber vars already set in the session.
		if (process.env[k] === undefined) {
			process.env[k] = expandValue(v, envFile, process.env, new Set([k]));
		}
	}
}

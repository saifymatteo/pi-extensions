/**
 * Runtime defaults and types for orchestrator.jsonc. The editor reference is the
 * hand-written schemas/orchestrator.schema.json; a test keeps its top-level
 * properties and `default` annotations in step with DEFAULT_CONFIG. The schema
 * is never a runtime validation gate.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface BuiltinFleetEntry {
	thinking?: (typeof THINKING_LEVELS)[number];
	hidden?: boolean;
}

export interface OrchestratorConfig {
	enabled: boolean;
	showFleetWidget: boolean;
	keepTools: string[];
	keepToolOverrides: Record<string, "allowed" | "blocked">;
	childBlockedTools: string[];
	childExtensions: string[];
	forwardParentPrompt: boolean;
	builtinFleet: boolean | Record<string, BuiltinFleetEntry>;
	modelOverrides: Record<string, string>;
	maxTurns: number;
	maxConcurrency: number;
	maxQueuedRuns: number;
	stallTimeoutMs: number;
	childSessions: boolean;
	async: boolean;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
	enabled: true,
	showFleetWidget: true,
	keepTools: ["delegate"],
	keepToolOverrides: {},
	childBlockedTools: [],
	childExtensions: [],
	forwardParentPrompt: true,
	builtinFleet: true,
	modelOverrides: {},
	maxTurns: 50,
	maxConcurrency: 4,
	maxQueuedRuns: 32,
	stallTimeoutMs: 600_000,
	childSessions: true,
	async: true,
};

/** `/orchestrator settings` fields: every simple key. Lists, maps and per-agent builtinFleet objects stay JSON-only. */
export const ORCHESTRATOR_SETTINGS_FIELDS = [
	{ key: "enabled", label: "Engaged", type: "boolean", default: DEFAULT_CONFIG.enabled,
		description: "Engage orchestration by default; /orchestrator toggles it. Off leaves normal pi tools available." },
	{ key: "showFleetWidget", label: "Fleet widget", type: "boolean", default: DEFAULT_CONFIG.showFleetWidget,
		description: "Show the live fleet widget in the transcript area." },
	{ key: "async", label: "Async dispatch", type: "boolean", default: DEFAULT_CONFIG.async,
		description: "Default delegate mode: on returns an acceptance at once and delivers the result later; off blocks." },
	{ key: "forwardParentPrompt", label: "Forward parent prompt", type: "boolean", default: DEFAULT_CONFIG.forwardParentPrompt,
		description: "Append the parent's pre-policy system prompt (extension guidelines included) to each child's prompt." },
	{ key: "childSessions", label: "Child sessions", type: "boolean", default: DEFAULT_CONFIG.childSessions,
		description: "Keep persistent subagent sessions beside the parent's session, linked to it." },
	{ key: "builtinFleet", label: "Builtin fleet", type: "boolean", default: true,
		fromFile: (raw: unknown) => (typeof raw === "boolean" ? raw : raw && typeof raw === "object" ? true : undefined),
		description: "Include the shipped agents. Saving here replaces a per-agent override object with on/off." },
	{ key: "maxTurns", label: "Max turns", type: "number", integer: true, min: 1, default: DEFAULT_CONFIG.maxTurns,
		description: "Default subagent turn budget; agent frontmatter maxTurns overrides it." },
	{ key: "maxConcurrency", label: "Max concurrency", type: "number", integer: true, min: 1, default: DEFAULT_CONFIG.maxConcurrency,
		description: "Maximum subagents running at once." },
	{ key: "maxQueuedRuns", label: "Max queued runs", type: "number", integer: true, min: 0, default: DEFAULT_CONFIG.maxQueuedRuns,
		description: "Maximum runs waiting for a slot; 0 disables the queue." },
	{ key: "stallTimeoutMs", label: "Stall timeout (ms)", type: "number", min: 1, default: DEFAULT_CONFIG.stallTimeoutMs,
		description: "Kill a subagent that prints nothing for this many milliseconds." },
] as const satisfies readonly {
	key: keyof OrchestratorConfig;
	label: string;
	description: string;
	type: "boolean" | "number";
	default: unknown;
	integer?: boolean;
	min?: number;
	fromFile?: (raw: unknown) => unknown;
}[];

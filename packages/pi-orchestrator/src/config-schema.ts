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

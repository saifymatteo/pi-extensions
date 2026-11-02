/** Synchronous, session-scoped discovery. Providers retain all execution state.
 * claim must validate the whole group before changing ownership (or roll itself back).
 * commit/release are synchronous, idempotent, and must not throw. commit consumes;
 * release restores normal delivery without cancelling work. Never retract native queues.
 */
export const ASYNC_WORK_PROVIDERS = "async-work:providers:v1";
export type WorkSource = "shell" | "agent";
export interface WorkResult {
	source: WorkSource;
	id: number;
	content: string;
	details: Record<string, unknown>;
}
export interface Lease {
	result: Promise<WorkResult[]>;
	commit(): void;
	release(): void;
}
export interface Provider {
	source: WorkSource;
	claim(ids: number[], owner: string): Lease;
}
export interface ProviderDiscovery {
	sessionFile?: string;
	/** Must be called synchronously: EventBus.emit returns void. */
	add(provider: Provider): void;
}

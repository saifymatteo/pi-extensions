import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ASYNC_WORK_PROVIDERS, type Lease, type Provider, type ProviderDiscovery, type WorkSource } from "./lib/async-work";

export default function (pi: ExtensionAPI) {
	let sequence = 0;
	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: "Join explicit background jobs (shell:1, agent:2). Returns all results together. Timeout releases delivery ownership without stopping jobs; Escape/parent abort retains fleet cancellation. Already consumed or externally submitted results cannot be joined.",
		parameters: Type.Object({
			jobs: Type.Array(Type.String({ pattern: "^(shell|agent):[1-9][0-9]*$" }), { minItems: 1, maxItems: 64, uniqueItems: true }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800000, default: 300000 })),
		}),
		promptGuidelines: ["After dispatch, do independent work first. When blocked on explicit jobs, use wait with their shell:<id>/agent:<id> references. Never sleep or poll to wait. Do not answer redundant messages for results already known individually."],
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { jobs, timeoutMs = 300000 } = params;
			if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 64 || new Set(jobs).size !== jobs.length)
				throw new Error("wait requires 1..64 unique job references");
			if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000)
				throw new Error("timeoutMs must be an integer from 1 to 1800000");
			const groups = new Map<WorkSource, number[]>();
			for (const ref of jobs) {
				const match = typeof ref === "string" && /^(shell|agent):([1-9][0-9]*)$/.exec(ref);
				if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error(`Invalid job reference: ${ref}`);
				const source = match[1] as WorkSource;
				groups.set(source, [...(groups.get(source) ?? []), Number(match[2])]);
			}
			const providers = new Map<WorkSource, Provider>();
			const duplicates = new Set<WorkSource>();
			const discovery: ProviderDiscovery = {
				sessionFile: ctx.sessionManager.getSessionFile(),
				add(provider) {
					if (providers.has(provider.source)) duplicates.add(provider.source);
					providers.set(provider.source, provider);
				},
			};
			pi.events.emit(ASYNC_WORK_PROVIDERS, discovery);
			const leases: Lease[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: (() => void) | undefined;
			const cancelled = "wait cancelled; delivery claims released (parent abort may cancel agents)";
			const checkActive = () => {
				if (signal?.aborted) throw new Error(cancelled);
				if (ctx.sessionManager.getSessionFile() !== discovery.sessionFile)
					throw new Error("wait session changed; delivery claims released");
			};
			try {
				checkActive();
				const owner = `wait:${toolCallId}:${++sequence}`;
				for (const [source, ids] of groups) {
					if (duplicates.has(source)) throw new Error(`Multiple ${source} providers for this session`);
					const provider = providers.get(source);
					if (!provider) throw new Error(`No ${source} provider for this session`);
					leases.push(provider.claim(ids, owner));
				}
				const interrupted = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(new Error(cancelled));
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
					timer = setTimeout(() => reject(new Error(`wait timed out after ${timeoutMs}ms; jobs continue running`)), timeoutMs);
				});
				const batches = await Promise.race([Promise.all(leases.map((lease) => lease.result)), interrupted]);
				checkActive();
				const all = batches.flat();
				// Validate producer output before consuming any lease.
				const results = jobs.map((ref) => {
					const matches = all.filter((result) => `${result.source}:${result.id}` === ref);
					if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || typeof matches[0].content !== "string" ||
						!matches[0].details || typeof matches[0].details !== "object" || Array.isArray(matches[0].details))
						throw new Error(`Invalid provider result for ${ref}`);
					return matches[0];
				});
				if (all.length !== jobs.length) throw new Error("Unexpected provider results");
				// Materialize a JSON-safe snapshot before committing: producer metadata may be invalid.
				const response = JSON.parse(JSON.stringify({ content: [{ type: "text", text:
					results.map((result) => `[${result.source}:${result.id}]\n${result.content}`).join("\n\n") }], details: { results } }));
				checkActive();
				for (const lease of leases) lease.commit();
				return response;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				for (const lease of leases) lease.release();
			}
		},
	});
}

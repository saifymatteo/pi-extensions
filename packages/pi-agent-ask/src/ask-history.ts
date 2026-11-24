import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	type HistoryCompletion,
	HistoryCompletionSchema,
	type HistoryRequest,
	HistoryRequestSchema,
} from "./ask-history-schema.ts";
import type { QueuedAnswer } from "./background-ask-state.ts";
import type { AskState } from "./types.ts";

const REQUEST_ENTRY = "ask:history-request";
const COMPLETION_ENTRY = "ask:history-completed";
type HistoryWriter = Pick<ExtensionAPI, "appendEntry">;

/** Save the normalized, loaded form before opening UI. Each invocation gets a new key. */
export function appendAskHistoryRequest(
	pi: HistoryWriter,
	toolCallId: string,
	state: AskState,
	background: boolean
): string {
	const requestId = randomUUID();
	const questions = state.questions.map(({ requestedType, ...question }) => ({
		...question,
		type: requestedType ?? question.type,
	}));
	pi.appendEntry(
		REQUEST_ENTRY,
		structuredClone({
			version: 1,
			requestId,
			toolCallId,
			title: state.title,
			background,
			createdAt: new Date().toISOString(),
			questions,
		} satisfies HistoryRequest)
	);
	return requestId;
}

/** Save an outcome before delivering it to the agent, including nested tool calls. */
export function appendAskHistoryCompletion(
	pi: HistoryWriter,
	completion: QueuedAnswer
): void {
	pi.appendEntry(
		COMPLETION_ENTRY,
		structuredClone({ version: 1, ...completion } satisfies HistoryCompletion)
	);
}

/** Recover the original journal identity when an interrupted tool request is reopened. */
export function findPendingHistoryRequest(
	branch: readonly SessionEntry[],
	toolCallId: string
): string | undefined {
	const completed = new Set<string>();
	for (const entry of [...branch].reverse()) {
		if (entry.type !== "custom") {
			continue;
		}
		if (
			entry.customType === COMPLETION_ENTRY &&
			Value.Check(HistoryCompletionSchema, entry.data)
		) {
			completed.add(entry.data.requestId);
		}
		if (
			entry.customType === REQUEST_ENTRY &&
			Value.Check(HistoryRequestSchema, entry.data) &&
			entry.data.toolCallId === toolCallId &&
			!completed.has(entry.data.requestId)
		) {
			return entry.data.requestId;
		}
	}
	return;
}

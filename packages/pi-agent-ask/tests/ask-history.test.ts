import assert from "node:assert/strict";
import test from "node:test";
import {
	appendAskHistoryCompletion,
	appendAskHistoryRequest,
	findPendingHistoryRequest,
} from "../src/ask-history.ts";
import { createInitialState } from "../src/state/create.ts";

const state = createInitialState({
	title: "Choose scope",
	questions: [
		{
			id: "scope",
			prompt: "Which scope?",
			options: [{ value: "small", label: "Small" }],
		},
	],
});

function journal() {
	const branch: unknown[] = [];
	return {
		branch,
		pi: {
			appendEntry: (type: string, data: unknown) => {
				branch.push({ type: "custom", customType: type, data });
			},
		},
	};
}

test("findPendingHistoryRequest returns an open request and skips a completed one", () => {
	const { branch, pi } = journal();
	const first = appendAskHistoryRequest(pi, "call-1", state, false);
	assert.equal(findPendingHistoryRequest(branch as never, "call-1"), first);

	const second = appendAskHistoryRequest(pi, "call-2", state, true);
	appendAskHistoryCompletion(pi, { requestId: second, error: "boom" });

	assert.equal(findPendingHistoryRequest(branch as never, "call-2"), undefined);
	assert.equal(findPendingHistoryRequest(branch as never, "call-1"), first);
	assert.equal(
		findPendingHistoryRequest(branch as never, "missing"),
		undefined
	);
});

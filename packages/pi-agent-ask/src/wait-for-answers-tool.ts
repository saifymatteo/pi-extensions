import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatQueuedAnswer } from "./background-answer.ts";
import type { BackgroundAskRuntime } from "./background-ask.ts";
import {
	type WaitForAnswersResult,
	WaitForAnswersSchema,
} from "./background-ask-state.ts";
import { imageContent } from "./images.ts";

/** Register the explicit wait gate. Completed answers use this result instead of duplicate messages. */
export function registerWaitForAnswersTool(
	pi: ExtensionAPI,
	queue: BackgroundAskRuntime
): void {
	pi.registerTool({
		name: "wait_for_answers",
		exposure: "model-only",
		label: "Wait for Answers",
		description:
			"Wait for all outstanding background ask_user forms. No timeout; aborting leaves forms queued. Returns only undelivered results.",
		promptSnippet: "Wait for pending user answers",
		promptGuidelines: [
			"Read delivered background answers. Treat cancellation as no approval and elaboration as a clarification request.",
		],
		parameters: Type.Object({}),
		outputSchema: WaitForAnswersSchema,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				throw new Error("wait_for_answers requires interactive TUI mode.");
			}
			const result = await queue.wait(signal);
			return {
				content: [
					{ type: "text", text: formatWaitResult(result) },
					...result.results.flatMap((answer) =>
						answer.result ? imageContent(answer.result) : []
					),
				],
				details: result,
				structuredContent: result,
			};
		},
		renderCall: (_args, theme) =>
			new Text(theme.fg("toolTitle", theme.bold("wait_for_answers")), 0, 0),
		renderResult: (result) =>
			new Text(
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
				0,
				0
			),
	});
}

function formatWaitResult(result: WaitForAnswersResult): string {
	return result.results.length
		? result.results.map(formatQueuedAnswer).join("\n\n")
		: "No outstanding background answers. Previously delivered answers are already in context.";
}

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const AskOptionSchema = Type.Object({
	value: Type.String({
		description: "Stable answer value",
	}),
	label: Type.String({
		description: "Short visible label",
	}),
	description: Type.Optional(
		Type.String({
			description: "One-line explanation",
		})
	),
	preview: Type.Optional(
		Type.String({
			description: "Preview-pane text",
		})
	),
	previewFile: Type.Optional(
		Type.String({
			description:
				"For long content already on disk. UTF-8 path, absolute or relative to cwd; use instead of preview.",
		})
	),
	recommended: Type.Optional(
		Type.Boolean({
			description:
				"Mark grounded preferences; explain why in description. Not preselected.",
		})
	),
});

export const AskQuestionSchema = Type.Object({
	id: Type.String({
		description: "Stable key in returned answers",
	}),
	label: Type.Optional(
		Type.String({
			description: "Short tab label",
		})
	),
	prompt: Type.String({
		description: "Ask one decision per question",
	}),
	type: Type.Optional(
		StringEnum(["single", "multi", "preview"] as const, {
			description:
				"single (default): one choice; multi: several; preview: every option needs preview or previewFile.",
		})
	),
	required: Type.Optional(
		Type.Boolean({
			description: "Advisory only; never blocks submission",
		})
	),
	options: Type.Array(AskOptionSchema, {
		description: "Distinct, relevant choices",
	}),
});

export const AskParamsSchema = Type.Object({
	background: Type.Optional(
		Type.Boolean({
			description:
				"Queue and return a receipt, not an answer; answers arrive asynchronously or through wait_for_answers.",
		})
	),
	title: Type.Optional(Type.String()),
	questions: Type.Array(AskQuestionSchema),
});

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { QueuedAnswerSchema } from "./background-ask-state.ts";
import { AskQuestionSchema } from "./schema.ts";

const QuestionType = StringEnum(["single", "multi", "preview"] as const);
export const HistoryQuestionSchema = Type.Object({
	...AskQuestionSchema.properties,
	label: Type.String(),
	type: QuestionType,
	presentedType: Type.Optional(QuestionType),
});
export const HistoryRequestSchema = Type.Object({
	version: Type.Literal(1),
	requestId: Type.String(),
	toolCallId: Type.String(),
	title: Type.Optional(Type.String()),
	background: Type.Boolean(),
	createdAt: Type.String(),
	questions: Type.Array(HistoryQuestionSchema),
});
export const HistoryCompletionSchema = Type.Object({
	version: Type.Literal(1),
	...QueuedAnswerSchema.properties,
});
export type HistoryRequest = Static<typeof HistoryRequestSchema>;
export type HistoryCompletion = Static<typeof HistoryCompletionSchema>;

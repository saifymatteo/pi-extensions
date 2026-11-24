import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskSettingsCommand } from "./ask-settings-command.ts";
import { registerAskTool } from "./ask-tool.ts";
import { registerBackgroundAnswerRenderer } from "./background-answer.ts";
import { createBackgroundAskRuntime } from "./background-ask.ts";
import { resetAskConfigStore } from "./config/store.ts";
import { createRemoteAskRuntime } from "./remote-ask.ts";
import { registerPendingAskResume } from "./resume-pending-ask.ts";
import { registerWaitForAnswersTool } from "./wait-for-answers-tool.ts";

export default function askExtension(pi: ExtensionAPI) {
	resetAskConfigStore();
	const remoteAsk = createRemoteAskRuntime(pi.events);
	pi.on("session_shutdown", () => {
		remoteAsk.disposeAll();
	});
	const backgroundAsk = createBackgroundAskRuntime(pi, remoteAsk);
	registerBackgroundAnswerRenderer(pi);
	registerAskTool(pi, remoteAsk, backgroundAsk);
	registerWaitForAnswersTool(pi, backgroundAsk);
	registerAskSettingsCommand(pi);
	registerPendingAskResume(pi, remoteAsk);
}

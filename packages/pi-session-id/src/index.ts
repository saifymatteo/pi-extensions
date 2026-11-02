import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("session-id", {
		description: "Copy the current session ID to the clipboard",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				await copyToClipboard(sessionId);
			} catch (error) {
				ctx.ui.notify(
					`Could not copy session ID: ${error instanceof Error ? error.message : String(error)}\nSession ID: ${sessionId}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`Copied session ID: ${sessionId}`, "info");
		},
	});
}

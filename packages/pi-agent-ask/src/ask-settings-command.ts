import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { showAskSettings } from "./ui/show-settings.ts";

export function registerAskSettingsCommand(pi: ExtensionAPI) {
	pi.registerCommand("ask", {
		description: "Ask forms: /ask settings opens ask settings",
		getArgumentCompletions: (prefix: string) =>
			"settings".startsWith(prefix)
				? [{ value: "settings", label: "settings", description: "Open ask settings" }]
				: null,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim() !== "settings") {
				ctx.ui.notify("Usage: /ask settings", "warning");
				return;
			}
			await showAskSettings(ctx);
		},
	});
}

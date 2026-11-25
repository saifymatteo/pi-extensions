/**
 * Collection-only `/pi-extensions` hub (never published as a standalone package):
 * - `/pi-extensions` picks a loaded package and runs its own settings command.
 * - `/pi-extensions settings` turns packages on or off (`disabled` in pi-extensions.json; applies on /reload).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const SCHEMA_URL = "https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/schemas/pi-extensions.schema.json";
// Every collection package: its gate name is its wrapper file name (check-packages keeps them in sync).
const PACKAGES: string[] = [
	"pi-9router", "pi-agent-ask", "pi-atelier", "pi-bg-bash", "pi-claude-usage", "pi-clipboard-image",
	"pi-codeblock-borders", "pi-codegraph", "pi-compact-tools", "pi-decisions", "pi-draft", "pi-load-pi-dotenv",
	"pi-model-go", "pi-orchestrator", "pi-prestart-working", "pi-root-guard", "pi-session-finder", "pi-session-id",
	"pi-session-nav", "pi-session-rename", "pi-session-retention", "pi-skill-usage-log", "pi-tool-usage-log", "pi-tts",
	"pi-user-image-previews", "pi-vision", "pi-wait", "pi-x-ide", "pi-zvec",
];

/** Package → the command that opens its settings. Listed only when that command is loaded. */
export { PACKAGES };

export const SETTINGS_COMMANDS: ReadonlyArray<{ pkg: string; command: string; args: string }> = [
	{ pkg: "pi-x-ide", command: "ide", args: "settings" },
	{ pkg: "pi-atelier", command: "atelier", args: "" },
	{ pkg: "pi-orchestrator", command: "orchestrator", args: "settings" },
	{ pkg: "pi-agent-ask", command: "ask", args: "settings" },
	{ pkg: "pi-codegraph", command: "codegraph", args: "settings" },
	{ pkg: "pi-zvec", command: "zvec", args: "settings" },
	{ pkg: "pi-9router", command: "9router", args: "settings" },
	{ pkg: "pi-vision", command: "vision", args: "settings" },
];

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "pi-extensions.json");
}

function readConfig(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function disabledList(config: Record<string, unknown>): string[] {
	return Array.isArray(config.disabled) ? config.disabled.filter((name): name is string => typeof name === "string") : [];
}

async function openPackageToggles(ctx: ExtensionCommandContext): Promise<void> {
	const { openSettingsDialog } = await import("../packages/pi-x-ide/src/settings-dialog.ts");
	await openSettingsDialog(ctx, {
		title: "pi-extensions packages",
		scopes: [
			{
				id: "global",
				path: configPath(),
				read: () => {
					const disabled = new Set(disabledList(readConfig()));
					return Object.fromEntries(PACKAGES.filter((pkg) => disabled.has(pkg)).map((pkg) => [pkg, false]));
				},
				save: (patch) => {
					const config = readConfig();
					const disabled = new Set(disabledList(config));
					for (const [pkg, enabled] of Object.entries(patch)) {
						if (enabled === false) disabled.add(pkg);
						else disabled.delete(pkg);
					}
					// Keep unknown keys and names; order known packages like the inventory.
					const next = {
						$schema: SCHEMA_URL,
						...config,
						disabled: [...PACKAGES.filter((pkg) => disabled.has(pkg)), ...[...disabled].filter((pkg) => !PACKAGES.includes(pkg))],
					};
					mkdirSync(dirname(configPath()), { recursive: true });
					writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
				},
			},
		],
		fields: PACKAGES.map((pkg) => ({
			key: pkg,
			label: pkg,
			description: `Load ${pkg}. Off skips it on the next /reload.`,
			type: "boolean" as const,
			default: true,
			requiresReload: true,
		})),
		footnote: "Each package's own settings: /pi-extensions (no argument).",
	});
}

async function openPicker(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const loaded = new Set(pi.getCommands().filter((command) => command.source === "extension").map((command) => command.name));
	const entries = SETTINGS_COMMANDS.filter((entry) => loaded.has(entry.command)).map((entry) => ({
		label: `${entry.pkg}  /${entry.command}${entry.args ? ` ${entry.args}` : ""}`,
		run: () => `/${entry.command}${entry.args ? ` ${entry.args}` : ""}`,
	}));
	const PACKAGES_LABEL = "Packages: turn on or off";
	const choice = await ctx.ui.select("pi-extensions settings", [PACKAGES_LABEL, ...entries.map((entry) => entry.label)]);
	if (choice === undefined) return;
	if (choice === PACKAGES_LABEL) return openPackageToggles(ctx);
	const entry = entries.find((candidate) => candidate.label === choice);
	if (!entry) return;
	if (!ctx.isIdle()) {
		ctx.ui.notify(`Wait for the agent to finish, or run ${entry.run()} yourself.`, "warning");
		return;
	}
	// Runs the package's command exactly as if typed; no turn starts.
	pi.sendUserMessage(entry.run(), { expandPromptTemplates: true });
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("pi-extensions", {
		description: "pi-extensions: pick a package's settings; /pi-extensions settings turns packages on or off",
		getArgumentCompletions: (prefix: string) =>
			"settings".startsWith(prefix) ? [{ value: "settings", label: "settings", description: "Turn packages on or off" }] : null,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`/pi-extensions needs the TUI; edit ${configPath()} instead.`, "warning");
				return;
			}
			const sub = args.trim();
			if (sub === "settings") return openPackageToggles(ctx);
			if (sub) {
				ctx.ui.notify("Usage: /pi-extensions [settings]", "warning");
				return;
			}
			await openPicker(pi, ctx);
		},
	});
}

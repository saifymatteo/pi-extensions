// ABOUTME: `/ide settings`: Global / Project scope picker, then every simple pi-x-ide setting.
// ABOUTME: Built on the shared settings dialog (src/settings-dialog.ts); saves patch the chosen file.
import { existsSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AUTO_INSTALL_ENV_KEY,
  parseAutoInstallValue,
  SCHEMA_URL,
  readPiConfigSendContext,
  resolvePiConfigPath,
  resolvePiGlobalConfigPath,
  resolvePiProjectConfigPath,
  resolveLegacyPiProjectConfigPath,
  STATUS_DISPLAY_CONFIG_KEY,
} from "../shared/config.ts";
import { CONFIG_OPTIONS } from "../shared/config-options.ts";
import { jsonFileScope, openSettingsDialog, type SettingsField } from "../settings-dialog.ts";
import type { PiIdeRuntime } from "./state.ts";
import { updateIdeUi } from "./ui.ts";

/** Every simple pi-x-ide setting; `env` keys other than AutoInstall stay JSON-only. */
export const IDE_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: STATUS_DISPLAY_CONFIG_KEY,
    label: "Display",
    description: "IDE status placement: widget (above editor) or statusline (footer).",
    type: "enum",
    options: CONFIG_OPTIONS.status_display.enum,
    default: CONFIG_OPTIONS.status_display.default,
  },
  {
    key: "zedNested",
    label: "Zed nested",
    description: CONFIG_OPTIONS.zedNested.description,
    type: "enum",
    options: CONFIG_OPTIONS.zedNested.enum,
    default: CONFIG_OPTIONS.zedNested.default,
    requiresReload: true,
  },
  {
    key: `env.${AUTO_INSTALL_ENV_KEY}`,
    label: "AutoInstall",
    description: "Auto-install the VS Code-family extension on Pi startup (PI_X_IDE_AUTO_INSTALL).",
    type: "boolean",
    default: true,
    fromFile: (raw) =>
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? parseAutoInstallValue(String(raw))
        : undefined,
    toFile: (value) => (value ? "true" : "false"),
    requiresReload: true,
  },
  {
    key: "fixPrompt",
    label: "Fix prompt",
    description: "Prompt for IDE diagnostic fixes; {DIAGNOSTIC} marks where the diagnostic goes (\\n is a newline).",
    type: "text",
    default: CONFIG_OPTIONS.fixPrompt.default,
  },
  {
    key: "sendContext",
    label: "Send context",
    description: "Attach IDE context to prompts. Off starts every session paused (⊘); /ide skip still toggles per session.",
    type: "boolean",
    default: CONFIG_OPTIONS.sendContext.default,
  },
];

export async function showIdeSettings(
  runtime: PiIdeRuntime,
  ctx: ExtensionCommandContext,
  options: { home?: string } = {},
): Promise<void> {
  const projectPath = resolvePiProjectConfigPath(ctx.cwd);
  const legacyProject = resolveLegacyPiProjectConfigPath(ctx.cwd);
  const projectBase = !existsSync(projectPath) && existsSync(legacyProject) ? legacyProject : projectPath;
  await openSettingsDialog(ctx, {
    title: "pi-x-ide settings",
    scopes: [
      jsonFileScope("global", resolvePiGlobalConfigPath(options.home), SCHEMA_URL, {
        readPath: resolvePiConfigPath(options.home),
      }),
      jsonFileScope("project", projectPath, SCHEMA_URL, { readPath: projectBase }),
    ],
    fields: IDE_SETTINGS_FIELDS,
    footnote: "Other env overrides (PI_X_IDE_*) stay JSON-only.",
    onSaved: () => {
      runtime.contextPaused = !readPiConfigSendContext({ projectDir: ctx.cwd, home: options.home });
      updateIdeUi(runtime, ctx);
    },
  });
}

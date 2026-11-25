// Shared `/<command> settings` dialog: pick a scope (Global / Project), edit simple fields, ctrl+s saves.
// Every package with a settings dialog ships an identical copy of this file at src/settings-dialog.ts;
// scripts/check-packages.mjs asserts the copies match, so edit one and copy it to the others.
// Lists, maps, model chains and keymaps stay JSON-only: name their file in `footnote`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type SettingsScopeId = "global" | "project";

export interface SettingsScope {
  id: SettingsScopeId;
  /** File this scope reads and writes. */
  path: string;
  /** Parsed file contents; {} when the file is missing or invalid. */
  read(): Record<string, unknown>;
  /** Persist dot-path keys; an `undefined` value removes the key. */
  save(patch: Record<string, unknown>): void | Promise<void>;
  /** Set false to list the scope without letting it open (explain why in `note`). */
  available?: boolean | undefined;
  note?: string | undefined;
  /** Project only: false when this file replaces Global instead of overriding it key by key. */
  inheritsGlobal?: boolean | undefined;
}

export interface SettingsField {
  /** Dot path in the config file, e.g. "tools.fetch". */
  key: string;
  label: string;
  description: string;
  type: "boolean" | "enum" | "number" | "text";
  default: unknown;
  options?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** Scopes that may store this field; all by default. */
  scopes?: readonly SettingsScopeId[];
  /** Raw file value to field value; return undefined for unset or invalid. */
  fromFile?(raw: unknown): unknown;
  /** Field value to raw file value. */
  toFile?(value: unknown): unknown;
  /** The change applies only after /reload. */
  requiresReload?: boolean;
}

export interface SettingsDialogOptions {
  title: string;
  scopes: SettingsScope[];
  fields: SettingsField[];
  /** Dim line naming the settings that stay JSON-only. */
  footnote?: string | undefined;
  /** Runs after a successful save, before the dialog closes. */
  onSaved?(scope: SettingsScopeId): void | Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function getSettingsPath(doc: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), doc);
}

/** Copy of `doc` with dot-path keys set; `undefined` removes a key and then any object it leaves empty. */
export function applySettingsPatch(doc: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(doc);
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    const chain: Record<string, unknown>[] = [out];
    for (const part of parts.slice(0, -1)) {
      const parent = chain[chain.length - 1]!;
      if (!isRecord(parent[part])) {
        if (value === undefined) break;
        parent[part] = {};
      }
      chain.push(parent[part] as Record<string, unknown>);
    }
    if (chain.length !== parts.length) continue;
    const last = parts[parts.length - 1]!;
    if (value !== undefined) {
      chain[chain.length - 1]![last] = value;
      continue;
    }
    delete chain[chain.length - 1]![last];
    for (let i = chain.length - 1; i > 0 && Object.keys(chain[i]!).length === 0; i--) delete chain[i - 1]![parts[i - 1]!];
  }
  return out;
}

/**
 * A plain-JSON scope. Reads `readPath` (a legacy file, when that is all there is) or `path`, and saves
 * the patched document to `path` with `$schema` first when absent. Unknown keys are kept.
 */
export function jsonFileScope(
  id: SettingsScopeId,
  path: string,
  schemaUrl: string,
  options: { readPath?: string | undefined; available?: boolean | undefined; note?: string | undefined } = {},
): SettingsScope {
  const read = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(options.readPath ?? path, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return {
    id,
    path,
    read,
    available: options.available,
    note: options.note,
    save: (patch) => {
      const current = read();
      const document = applySettingsPatch({ ...(current.$schema === undefined ? { $schema: schemaUrl } : {}), ...current }, patch);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    },
  };
}

function isValid(field: SettingsField, value: unknown): boolean {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (field.options ?? []).includes(value);
    case "text":
      return typeof value === "string";
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!field.integer || Number.isInteger(value)) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
      );
  }
}

function readField(field: SettingsField, doc: Record<string, unknown>): unknown {
  const raw = getSettingsPath(doc, field.key);
  const value = field.fromFile ? field.fromFile(raw) : raw;
  return isValid(field, value) ? value : undefined;
}

/** Text values edit and display on one line, with newlines and tabs as JSON escapes. */
const escapeText = (value: string): string => JSON.stringify(value).slice(1, -1);
function unescapeText(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

function show(field: SettingsField, value: unknown): string {
  if (value === undefined) return "unset";
  if (field.type === "boolean") return value ? "on" : "off";
  if (field.type === "text") return value === "" ? "(empty)" : escapeText(String(value));
  return String(value);
}

function parseNumber(field: SettingsField, text: string): number | string {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) return "Enter a number";
  if (field.integer && !Number.isInteger(value)) return "Enter a whole number";
  if (field.min !== undefined && value < field.min) return `Minimum is ${field.min}`;
  if (field.max !== undefined && value > field.max) return `Maximum is ${field.max}`;
  return value;
}

function tildify(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

const SCOPE_LABELS: Record<SettingsScopeId, string> = { global: "Global", project: "Project" };

/** Open the dialog in TUI mode; elsewhere, name the files to edit instead. */
export async function openSettingsDialog(ctx: ExtensionContext, options: SettingsDialogOptions): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(`${options.title} needs the TUI. Edit ${options.scopes.map((s) => s.path).join(" or ")}`, "warning");
    return;
  }
  const saved = await ctx.ui.custom<{ scope: SettingsScope; reload: boolean } | undefined>(
    (tui, theme, _keybindings, done) => createSettingsDialog(options, theme, () => tui.requestRender(), done),
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%" } },
  );
  if (saved) {
    ctx.ui.notify(`Saved ${SCOPE_LABELS[saved.scope.id]} settings: ${tildify(saved.scope.path)}${saved.reload ? " · /reload to apply" : ""}`, "info");
  }
}

/** The dialog component; exported for tests. */
export function createSettingsDialog(
  options: SettingsDialogOptions,
  theme: Theme,
  requestRender: () => void,
  done: (result: { scope: SettingsScope; reload: boolean } | undefined) => void,
): { render(width: number): string[]; invalidate(): void; handleInput(data: string): void } {
  const available = options.scopes.filter((scope) => scope.available !== false);
  let scopeIndex = 0;
  let scope: SettingsScope | undefined;
  let stored: Map<string, unknown> = new Map();
  let draft: Map<string, unknown> = new Map();
  let inherited: Map<string, unknown> = new Map();
  let row = 0;
  let editing: string | undefined;
  let message: { text: string; tone: "error" | "warning" } | undefined;
  let saving = false;

  const allowed = (field: SettingsField): boolean => !scope || !field.scopes || field.scopes.includes(scope.id);

  const open = (next: SettingsScope): void => {
    scope = next;
    const doc = next.read();
    stored = new Map(options.fields.map((field) => [field.key, readField(field, doc)]));
    draft = new Map(stored);
    const globalScope =
      next.id === "project" && next.inheritsGlobal !== false ? options.scopes.find((s) => s.id === "global") : undefined;
    const globalDoc = globalScope?.read() ?? {};
    inherited = new Map(options.fields.map((field) => [field.key, readField(field, globalDoc) ?? field.default]));
    row = Math.max(0, options.fields.findIndex(allowed));
    editing = undefined;
    message = undefined;
  };

  const dirtyKeys = (): string[] => options.fields.filter((f) => draft.get(f.key) !== stored.get(f.key)).map((f) => f.key);

  const set = (field: SettingsField, value: unknown): void => {
    draft.set(field.key, value);
    message = undefined;
  };

  const change = (field: SettingsField): void => {
    const current = draft.get(field.key) ?? inherited.get(field.key);
    if (field.type === "boolean") set(field, !current);
    else if (field.type === "enum") {
      const values = field.options ?? [];
      set(field, values[(values.indexOf(current as string) + 1) % values.length]);
    } else if (field.type === "text") editing = escapeText(String(current ?? ""));
    else editing = current === undefined ? "" : String(current);
  };

  const commitEdit = (field: SettingsField): void => {
    const text = editing ?? "";
    if (field.type === "number") {
      const value = parseNumber(field, text);
      if (typeof value === "string") {
        message = { text: value, tone: "error" };
        return;
      }
      set(field, value);
    } else set(field, unescapeText(text));
    editing = undefined;
  };

  const save = async (): Promise<void> => {
    if (!scope || saving) return;
    const keys = dirtyKeys();
    if (keys.length === 0) {
      done(undefined);
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const field of options.fields.filter((f) => keys.includes(f.key))) {
      const value = draft.get(field.key);
      patch[field.key] = value === undefined || !field.toFile ? value : field.toFile(value);
    }
    saving = true;
    try {
      await scope.save(patch);
      await options.onSaved?.(scope.id);
      const reload = options.fields.some((f) => f.requiresReload && keys.includes(f.key));
      done({ scope, reload });
    } catch (error) {
      message = { text: `Save failed: ${error instanceof Error ? error.message : String(error)}`, tone: "error" };
      requestRender();
    } finally {
      saving = false;
    }
  };

  const back = (): void => {
    if (dirtyKeys().length > 0 && message?.tone !== "warning") {
      message = { text: "Unsaved changes: esc again to discard, ctrl+s to save", tone: "warning" };
      return;
    }
    if (available.length > 1) scope = undefined;
    else done(undefined);
  };

  const handleEditInput = (data: string): void => {
    const field = options.fields[row]!;
    if (matchesKey(data, Key.escape)) editing = undefined;
    else if (matchesKey(data, Key.enter)) commitEdit(field);
    else if (matchesKey(data, Key.backspace)) editing = (editing ?? "").slice(0, -1);
    else {
      const text = decodeKittyPrintable(data) ?? data;
      if (!text.startsWith("\u001b") && /^[^\u0000-\u001f\u007f]+$/.test(text)) editing = (editing ?? "") + text;
    }
  };

  const handleFieldInput = (data: string): void => {
    const field = options.fields[row]!;
    const step = (delta: number): void => {
      for (let next = row + delta; next >= 0 && next < options.fields.length; next += delta) {
        if (allowed(options.fields[next]!)) {
          row = next;
          message = message?.tone === "warning" ? message : undefined;
          return;
        }
      }
    };
    if (matchesKey(data, Key.up)) step(-1);
    else if (matchesKey(data, Key.down)) step(1);
    else if (matchesKey(data, Key.ctrl("s"))) void save();
    else if (matchesKey(data, Key.escape)) back();
    else if (!allowed(field)) return;
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) change(field);
    else if (data === "x" || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) set(field, undefined);
  };

  const handleScopeInput = (data: string): void => {
    const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
    if (matchesKey(data, Key.up)) scopeIndex = Math.max(0, scopeIndex - 1);
    else if (matchesKey(data, Key.down)) scopeIndex = Math.min(available.length - 1, scopeIndex + 1);
    else if (matchesKey(data, Key.escape)) done(undefined);
    else if (digit >= 0 && digit < available.length) open(available[digit]!);
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) open(available[scopeIndex]!);
  };

  if (available.length === 1) open(available[0]!);

  const frame = (width: number, title: string, body: string[]): string[] => {
    const inner = Math.max(10, width - 4);
    const label = truncateToWidth(` ${title} `, inner - 2, "…");
    const top = theme.fg("accent", `╭─${theme.bold(label)}${"─".repeat(Math.max(0, inner - label.length))}─╮`);
    const side = theme.fg("accent", "│");
    const lines = body.map((line) => `${side} ${truncateToWidth(line, inner, "…", true)} ${side}`);
    return [top, ...lines, theme.fg("accent", `╰${"─".repeat(inner + 2)}╯`)];
  };

  const renderScopes = (width: number): string[] => {
    const body: string[] = [theme.fg("dim", "Choose which file to edit. Project values override Global."), ""];
    options.scopes.forEach((entry) => {
      const index = available.indexOf(entry);
      const selected = index === scopeIndex && index >= 0;
      const created = Object.keys(entry.read()).length > 0 ? "" : "not created";
      const head = `${selected ? theme.fg("accent", "▌ ") : "  "}${index >= 0 ? `${index + 1}. ` : "   "}${SCOPE_LABELS[entry.id].padEnd(9)}`;
      const label = index < 0 ? theme.fg("dim", head) : selected ? theme.fg("text", head) : theme.fg("muted", head);
      body.push(`${label}${theme.fg("dim", `${created.trim()}${entry.note ? `${created ? " · " : ""}${entry.note}` : ""}`)}`);
      body.push(theme.fg("dim", `     ${tildify(entry.path)}`));
    });
    if (options.footnote) body.push("", theme.fg("dim", options.footnote));
    body.push("", theme.fg("dim", "↑↓ move · enter open · esc close"));
    return frame(width, options.title, body);
  };

  const renderFields = (width: number): string[] => {
    const current = scope!;
    const labelWidth = Math.min(28, Math.max(...options.fields.map((f) => f.label.length)) + 2);
    const body: string[] = [theme.fg("dim", tildify(current.path)), ""];
    options.fields.forEach((field, index) => {
      const selected = index === row;
      const cursor = selected ? theme.fg("accent", "▌ ") : "  ";
      const label = field.label.padEnd(labelWidth);
      if (!allowed(field)) {
        body.push(`${cursor}${theme.fg("dim", `${label}${SCOPE_LABELS[field.scopes![0]!]} only`)}`);
        return;
      }
      const value = draft.get(field.key);
      const changed = value !== stored.get(field.key) ? theme.fg("warning", " *") : "";
      let shown: string;
      if (selected && editing !== undefined) shown = theme.fg("accent", `${editing}▏`);
      else if (value === undefined) {
        const source = current.id === "project" && current.inheritsGlobal !== false ? "inherited" : "default";
        shown = theme.fg("dim", `${show(field, inherited.get(field.key))} · ${source}`);
      } else shown = selected ? theme.fg("accent", show(field, value)) : theme.fg("text", show(field, value));
      body.push(`${cursor}${selected ? theme.fg("text", label) : theme.fg("muted", label)}${shown}${changed}`);
    });
    const field = options.fields[row];
    body.push("", field ? theme.fg("muted", field.description) : "");
    if (field?.type === "enum") body.push(theme.fg("dim", `Values: ${(field.options ?? []).join(", ")}`));
    if (message) body.push(theme.fg(message.tone, message.text));
    if (options.footnote) body.push("", theme.fg("dim", options.footnote));
    const reset = current.id === "project" && current.inheritsGlobal !== false ? "x inherit" : "x default";
    body.push(
      "",
      theme.fg(
        "dim",
        editing !== undefined
          ? "type to edit · enter accept · esc cancel"
          : `↑↓ move · space/enter change · ${reset} · ctrl+s save · esc ${available.length > 1 ? "back" : "close"}`,
      ),
    );
    return frame(width, `${options.title} · ${SCOPE_LABELS[current.id]}`, body);
  };

  return {
    render: (width) => (scope ? renderFields(width) : renderScopes(width)),
    invalidate: () => {},
    handleInput: (data) => {
      if (!scope) handleScopeInput(data);
      else if (editing !== undefined) handleEditInput(data);
      else handleFieldInput(data);
      requestRender();
    },
  };
}

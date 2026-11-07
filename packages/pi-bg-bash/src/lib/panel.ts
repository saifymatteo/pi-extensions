import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { oneLine } from "./output";
import type { StopMode } from "./process-control";

export interface JobView {
	id: number;
	command: string;
	tool: string;
	state: string;
	secs: number;
	running: boolean;
	stoppable: boolean;
}

interface Controls {
	list(): JobView[];
	output(id: number): string;
	stop(id: number, mode: StopMode): Promise<string>;
}

type Pick = { id: number; action: "view" | StopMode } | undefined;
const label = (job: JobView) => `#${job.id} [${job.tool}] ${job.state} · ${job.secs}s · ${oneLine(job.command).slice(0, 200)}`;

/** Human-only controls: inspecting output never claims or consumes agent results. */
export async function showJobPanel(ctx: ExtensionCommandContext, controls: Controls, signal: AbortSignal): Promise<void> {
	if (!controls.list().length) return ctx.ui.notify("No background jobs.", "info");
	if (!ctx.hasUI) return ctx.ui.notify(controls.list().map(label).join("\n"), "info");
	let selected: number | undefined;
	while (!signal.aborted) {
		let pick: Pick;
		if (ctx.mode === "tui") {
			pick = await ctx.ui.custom<Pick>((tui, theme, _keys, done) => {
				let list: SelectList;
				let visible: JobView[] = [];
				let disposed = false;
				const current = () => visible.find(job => String(job.id) === list?.getSelectedItem()?.value);
				const rebuild = () => {
					const keep = current()?.id ?? selected;
					visible = controls.list();
					list = new SelectList(visible.map(job => ({ value: String(job.id), label: label(job) })),
						Math.max(1, Math.min(10, tui.terminal.rows - 6)), {
							selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
							description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text),
							noMatch: text => theme.fg("dim", text),
						});
					list.setSelectedIndex(Math.max(0, visible.findIndex(job => job.id === keep)));
					list.onSelect = () => { const job = current(); if (job) finish({ id: job.id, action: "view" }); };
					list.onCancel = () => finish(undefined);
				};
				const dispose = () => {
					if (disposed) return;
					disposed = true;
					clearInterval(timer);
					signal.removeEventListener("abort", cancel);
				};
				const finish = (value: Pick) => { dispose(); done(value); };
				const cancel = () => finish(undefined);
				const timer = setInterval(() => { rebuild(); tui.requestRender(); }, 1000);
				rebuild();
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) queueMicrotask(cancel);
				return {
					dispose,
					invalidate() { list.invalidate(); },
					render(width: number) {
						return [theme.fg("accent", "Background jobs"), ...list.render(width),
							theme.fg("dim", "↑↓ select · Enter output · s stop gracefully · x force kill · Esc close")].map(line => truncateToWidth(line, width));
					},
					handleInput(data: string) {
						if (matchesKey(data, "x") || matchesKey(data, "s")) {
							const job = current();
							if (job) finish({ id: job.id, action: matchesKey(data, "x") ? "force" : "graceful" });
						} else if (matchesKey(data, "q")) finish(undefined);
						else list.handleInput(data);
						tui.requestRender();
					},
				};
			});
		} else {
			const visible = controls.list();
			const choices = visible.map(label);
			const choice = await ctx.ui.select("Background jobs", choices, { signal });
			const job = visible[choices.indexOf(choice ?? "")];
			if (!job || signal.aborted) return;
			const action = await ctx.ui.select(label(job), ["View output", "Stop gracefully", "Force kill", "Back"], { signal });
			if (action === undefined) return;
			if (action === "Back") continue;
			pick = { id: job.id, action: action === "Stop gracefully" ? "graceful" : action === "Force kill" ? "force" : "view" };
		}
		if (!pick || signal.aborted) return;
		selected = pick.id;
		const job = controls.list().find(job => job.id === pick.id);
		if (!job) continue;
		if (pick.action !== "view") {
			if (!job.stoppable) { ctx.ui.notify(`Job #${job.id} already finished.`, "info"); continue; }
			const force = pick.action === "force";
			if (!(await ctx.ui.confirm(`${force ? "Force kill" : "Gracefully stop"} background job #${job.id}?`,
				`${oneLine(job.command).slice(0, 500)}\n` + (force ?
					"Immediately terminates its tracked process tree. Cleanup hooks will not run." :
					"Requests Ctrl+C shutdown. Survivors remain available for Force kill; no automatic escalation."), { signal })) || signal.aborted) continue;
			ctx.ui.notify(`${force ? "Force killing" : "Gracefully stopping"} background job #${job.id}…`, "info");
			try {
				const message = await controls.stop(job.id, pick.action);
				if (!signal.aborted) ctx.ui.notify(message, "info");
			} catch (error) {
				if (!signal.aborted) ctx.ui.notify(`Could not stop job #${job.id}: ${oneLine(String(error))}`, "error");
			}
		} else if (ctx.mode !== "tui") ctx.ui.notify(controls.output(job.id), "info");
		else await ctx.ui.custom<void>((tui, theme, _keys, done) => {
			let text = controls.output(job.id);
			let top = Number.POSITIVE_INFINITY;
			let rows: string[] = [];
			let height = 1;
			let disposed = false;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clearInterval(timer);
				signal.removeEventListener("abort", finish);
			};
			const finish = () => { dispose(); done(); };
			const timer = setInterval(() => {
				const following = top >= Math.max(0, rows.length - height);
				text = controls.output(job.id);
				if (following) top = Number.POSITIVE_INFINITY;
				tui.requestRender();
			}, 1000);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) queueMicrotask(finish);
			return {
				dispose,
				invalidate() {},
				render(width: number) {
					height = Math.max(1, tui.terminal.rows - 6);
					rows = new Text(text || "(no output yet)", 0, 0).render(Math.max(1, width));
					top = Math.max(0, Math.min(top, rows.length - height));
					return [theme.fg("accent", label(controls.list().find(j => j.id === job.id) ?? job)),
						...rows.slice(top, top + height),
						theme.fg("dim", "↑↓ / PgUp / PgDn scroll · Home / End · Esc back")].map(line => truncateToWidth(line, width));
				},
				handleInput(data: string) {
					if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) finish();
					else if (matchesKey(data, "up")) top = Math.max(0, top - 1);
					else if (matchesKey(data, "down")) top = Math.min(Math.max(0, rows.length - height), top + 1);
					else if (matchesKey(data, "pageUp")) top = Math.max(0, top - height);
					else if (matchesKey(data, "pageDown")) top = Math.min(Math.max(0, rows.length - height), top + height);
					else if (matchesKey(data, "home")) top = 0;
					else if (matchesKey(data, "end")) top = Number.POSITIVE_INFINITY;
					tui.requestRender();
				},
			};
		});
	}
}

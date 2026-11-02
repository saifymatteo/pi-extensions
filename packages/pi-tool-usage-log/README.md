# pi-tool-usage-log

Passively record direct and nested tool executions and show aggregate usage, errors, duration, selected model and thinking level.

## Running locally

From the monorepo root:

```sh
pi -e ./packages/pi-tool-usage-log
```

**Warning:** this extension uses your existing Pi resources and settings unless you load it in an isolated home (see the root README). Do not load two copies of the same extension (for example an older standalone file alongside this package): commands and hooks can duplicate. The package never installs or relocates personal settings.

## Commands and shortcuts

- `/tool-usage` — opens the all-project report (no arguments).
- Up/Down, PageUp/PageDown, Home/End scroll; Escape/Ctrl+C/Enter close.

## Settings and storage

Appends JSONL records to `<agent-dir>/tool-usage.log`; `<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. No configuration file. The copied `skill-usage-log.ts` is a dialog sidecar only: only `src/index.ts` is a Pi manifest entry, so loading this package does not independently register skill logging.

## Privacy and operations

Log stores timestamps, session IDs, working directories, full tool/call/parent-call names, selected model/thinking level, status and durations, never tool arguments/results. No network requests. There is no rotation/deletion UI. Interrupted pending calls are flushed on orderly shutdown/session change; a hard crash can lose them. MCP tools aggregate by server in reports but keep full names on disk. Success means the tool returned, not that a background job eventually succeeded.

## Compatibility

Node.js >=24 for development checks; run extensions through Pi's TypeScript loader. Host imports are wildcard peers, not bundled runtime copies. Reports require interactive terminal mode; execution tracking needs Pi tool_execution_start/end hooks, including nested-event metadata for nested counts. Older hosts may omit these. Duration includes hooks/nested work and is not a pure tool benchmark.

See [NOTICE.md](NOTICE.md) for provenance. Tests use the monorepo's TypeScript dev dependency and VM loader; they do not contact services or write to user-home resources.

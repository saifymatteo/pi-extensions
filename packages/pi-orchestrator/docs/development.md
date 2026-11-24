# Development

[Quickstart](../README.md) · [Configuration](configuration.md) · [Usage](usage.md)

## Alternative installs

Requires Pi >= 1.0.4, as declared by the package peers. The event-bus integration uses Pi 1.3.0; see [Usage](usage.md#event-bus-integration-pi-130).

From git:

```bash
pi install git:github.com/saifymatteo/pi-extensions   # whole collection, includes pi-orchestrator
```

From a local clone, add the path to `packages` in `~/.pi/agent/settings.json`:

```jsonc
"packages": [
  // your other packages
  "<path-to-your-clone>/pi-extensions/packages/pi-orchestrator"
]
```

To test without installing:

```bash
pi -e <path-to-your-clone>/pi-extensions/packages/pi-orchestrator/src/index.ts
```

Avoid loading a second installed copy when testing a checkout. Start a fresh session after changing extension code.

## Architecture and policy layers

While engaged, the orchestrator parent runs on these layers:

| Layer | Mechanism |
|---|---|
| Policy | `before_agent_start` appends a delegation policy every turn: cached text, computed once per engagement from the discovered fleet and kept tools |
| Reduction | `setActiveTools` keeps only the effective keep-list (baseline plus per-tool overrides), re-applied every turn to catch late-registered tools |
| Gate | `tool_call` blocks anything not on the effective keep-list and nudges the model to delegate |
| Delegate tool | spawns `pi --mode rpc` children with `PI_ORCHESTRATOR_CHILD=1`; persistent sub-sessions by default (file-per-run in the parent's session dir, linked via `new_session {parentSession}`) |
| Turn budget | soft-grace steer at the budget, hard kill at budget + 5 turns |
| Stall watchdog | hard-kills a child silent for `stallTimeoutMs` (default 10 min); any output resets it |
| Child mode | children self-disable this extension; a parent-PID heartbeat watchdog exits them if pi dies |
| Child tool gate | children block tools matching `childBlockedTools` / per-agent `blockTools` at spawn (`--exclude-tools`, pi ≥ 1.0.4 patterns) plus a child-side gate backstop |
| Lifecycle owner | one live-session owner for async, blocking, and chain runs; shared capacity, queue, outcomes, and delivery state |
| UI | fleet widget above the editor projects the owner's state: queued/startup/running work and pending or failed result delivery, plus per-Worker progress |

## Policy and fleet text

pi-orchestrator computes the delegation policy once per engagement from what is actually installed and reuses it verbatim every turn: the allow-list names the tools retained at compute time, the fleet section lists the agents discovered at that point, and the typical-flows example is composed from the discovered names. The text is regenerated when engagement turns on again (session start with `enabled: true`, or `/orchestrator` re-engage). The schema enum reflects discovery at extension load; mid-session agent additions are available through the delegate tool's `list` action and current-name validation, not prompt rewrites. Successful manual tool-permission edits also refresh the cached policy on the next engaged turn. Nothing about other packages is hardcoded, so two installs with different packages produce slightly different policy text, and `builtinFleet: false`, `hidden: true`, and project agents all change what it says.

## Maintaining the configuration schema

`schemas/orchestrator.schema.json` is hand-written. When adding or changing a setting, edit it alongside `DEFAULT_CONFIG` in `src/config-schema.ts`: every property needs a `description` and a `default` equal to the runtime default. `tests/config-schema.test.ts` fails if the schema's top-level properties or defaults drift from `DEFAULT_CONFIG`. The schema's `$id` is its unversioned GitHub raw URL on `main`; no release bump is needed. See [ADR-0019](adr/0019-config-json-schema.md).

## Lifecycle verification

The lifecycle change's normal `npm test` command must include run-watcher tests and deterministic fixture-child tests alongside the existing suite. These cover shared admission, queueing, cancellation, cleanup, and delivery confirmation without model calls. Test inclusion and pass results must be verified with the implementation; no test count is promised here.

## File map

- `src/index.ts` handles the child watchdog, engagement, reduction, gate, and commands
- `src/config.ts` implements orchestrator.jsonc (JSONC, comment-preserving writes), keep-list matchers, and runtime tool discovery
- `src/config-schema.ts` holds the runtime defaults and config types; `schemas/orchestrator.schema.json` is the hand-written editor reference kept in step by a test
- `src/width.ts` provides ANSI-aware visible-width helpers for TUI rendering
- `src/agents.ts` discovers the fleet (builtin, user, project tree)
- `src/policy.ts` generates the delegation policy text from fleet and kept tools
- `src/run-lifecycle.ts` owns live-session admission, queueing, outcomes, delivery, and result leases
- `src/delegate.ts` implements the delegate tool: RPC child spawning, turn budget, stall watchdog, progress streaming, renderers, reaping
- `agents/*.md` holds the builtin fleet definitions
- `docs/adr/` collects the decision records

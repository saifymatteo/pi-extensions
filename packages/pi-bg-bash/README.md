# @saifymatteo/pi-bg-bash

## Purpose and registrations

Overrides `bash` and, when provided by the host, `powershell`, adding `background` and `job`. Registers `/bg`, result/call renderers, timeout injection, sleep-wait guard, session/settlement hooks, and shell provider discovery.

## Configuration and runtime

No extension-specific JSON. Reads `runTimeout.maxSeconds` and `runTimeout.codemodeMaxSeconds` from agent `settings.json` and project `.pi/settings.json`; defaults are 120s and 300s. The example is a settings fragment, not an extensions config. Requires the host's `createBashTool`, `createPowerShellTool`, renderer and settlement APIs; Windows uses Git Bash/MSYS or PowerShell. No model service required.

## Cooperative delivery contract

Use with `pi-wait` to join `shell:<id>` references. Synchronous session-scoped event `async-work:providers:v1` collects providers with `source` and `claim(ids, owner)`. A claim validates the entire ID group and returns `{ result, commit, release }`; commit consumes results, release restores normal delivery without cancelling execution. Commit/release must be synchronous, idempotent and nonthrowing. Claims prevent duplicate automatic delivery; queued/submitted or consumed outcomes cannot be joined. See `src/lib/async-work.ts`.

The agent orchestrator is a separate external extension, not included here. It must implement the same event contract for `agent:<id>`; neither this package nor wait creates agents.

## Security and lifecycle

Runs arbitrary shell commands with Pi's OS permissions. Detached processes can outlive Pi; shutdown clears watchers, not processes. Commands/output and status are stored in OS temp `pi-bg-*` files; stale matching files older than 24h are swept at factory load/shutdown. Output tails enter model context/session history. Avoid secrets in commands/output. Network access is whatever the command performs. Renderer ordering can hide the background badge when another extension owns shell rendering.

## Tests

From the monorepo root with its existing test dependencies available:

```sh
node --test packages/pi-bg-bash/test/*.test.mjs
```

Tests use the shared test-only TypeScript/VM loader, fixtures, and host/service stubs. They do not prove compatibility with a live host, CLI, or model service.

## Running locally

From the monorepo root:

```sh
pi -e ./packages/pi-bg-bash
```

Node >=24; host imports are peers, not bundled dependencies. Load only one copy: for an isolated session use `--no-extensions` with explicit `-e` paths so the original live extension is not also discovered. Set `PI_CODING_AGENT_DIR` to a disposable agent directory before launch; unset means the normal `~/.pi/agent` fallback. Extension config continues to resolve there, never relative to this package.

Examples are manually authored, sanitized reference documents, not runtime defaults. Review and manually create only the needed files in the isolated agent directory; do not copy live credentials or endpoints. No example is automatically loaded or copied. Loading an extension grants Pi-process OS permissions. This private package is UNLICENSED; publication requires clearance (NOTICE.md).

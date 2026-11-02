# @saifymatteo/pi-zvec

## Purpose and registrations

Registers `zvec_search` (exact/fts/vector/hybrid/auto), `/zvec-init`, `/zvec-sync`, `/zvec-status`, session and settle-sync hooks, and footer status.

## Configuration and external CLI

Requires external `zg` (`@zvec/zvec-grep`) on PATH. Windows first resolves the globally installed JS entry using npm, then executes with Node to preserve arguments; cmd-shim fallback may reparse shell metacharacters. No dependencies are installed by this package.

Reads `<agent-dir>/extensions/zvec.json`, then index-owner `.pi/zvec.json`: booleans `autoInit`, `syncOnSettle`, and string `embedding`. Missing config is auto-created with both flags **true** and `local/potion-code-16m-v2`. Example flags are false; an existing index still gets startup sync in UI modes. Exact mode uses managed ripgrep without an index or embedding model.

## Host limitations and security

Background indexing needs `ctx.hasUI` (TUI/RPC); commands still work without UI. Walks parents for `.zvec-grep`, stopping before home. Writes index data and an index `.gitignore`; appends timestamp/session/cwd/query/hit metadata to `<agent-dir>/zvec-usage.log`. Queries can be sensitive. Initial indexing can download an embedding model; CLI configuration determines any remote embedding/server traffic. Source/search results reach the main model. Use isolated agent/workspace directories for testing.

## Tests

From the monorepo root with its existing test dependencies available:

```sh
node --test packages/pi-zvec/test/*.test.mjs
```

Tests use the shared test-only TypeScript/VM loader, fixtures, and host/service stubs. They do not prove compatibility with a live host, CLI, or model service.

## Running locally

From the monorepo root:

```sh
pi -e ./packages/pi-zvec
```

Node >=24; host imports are peers, not bundled dependencies. Load only one copy: for an isolated session use `--no-extensions` with explicit `-e` paths so the original live extension is not also discovered. Set `PI_CODING_AGENT_DIR` to a disposable agent directory before launch; unset means the normal `~/.pi/agent` fallback. Extension config continues to resolve there, never relative to this package.

Examples are manually authored, sanitized reference documents, not runtime defaults. Review and manually create only the needed files in the isolated agent directory; do not copy live credentials or endpoints. No example is automatically loaded or copied. Loading an extension grants Pi-process OS permissions. Licensed AGPL-3.0-only; see [NOTICE.md](NOTICE.md).

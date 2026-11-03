# Pi extensions

Reusable pieces of a personal Pi setup, packaged separately from the setup itself.

**Work in progress.** Packages are licensed AGPL-3.0-only ([NOTICE.md](NOTICE.md)) and publish through GitHub Actions when tagged: each extension individually, plus the root as the all-in-one collection [`@saifymatteo/pi-extensions`](https://github.com/saifymatteo/pi-extensions). Git is local for now, with no GitHub repository yet.

## Start here

Use Node.js 24 or newer. From this repository:

```sh
npm ci
npm run typecheck
npm run check
npm test
npm run pack:check
npm run smoke
npm run context   # optional: per-package context-cost measurement
```

The completed checks and their limits are recorded in [VERIFICATION.md](VERIFICATION.md), including an initial temp-directory isolation gap and its correction.

Host-provided Pi packages (`@earendil-works/*`) are declared only as package peers — the Pi host supplies them at load time — while the root installs pinned copies as development dependencies solely so `tsc` can check extension sources against real host types. TypeScript (syntax checks and test transpilation), TypeBox (tool-schema tests), and Node's own types complete the dev dependencies; nothing here bundles a second copy of the agent host.

- `check`: validates the complete inventory, package boundaries, TypeScript syntax, declared imports, and publication fields. **Not semantic typechecking.**
- `test`: behavioral checks with explicit host stubs, temporary data, and no provider calls. This is not a full upstream regression suite.
- `pack:check`: asks npm to show each standalone package's and the root collection's prospective contents without publishing or creating archives.
- `smoke`: loads each package through isolated host help/startup. Checks module/factory loading, not session events, interactive rendering, models, external CLIs, or backend compatibility. The host is located automatically (`PI_HOST`, `pi` on PATH, then `pi-bolt` for a Pi-Bolt build, then the local `~/.pi-bolt` install). Pi-Bolt is optional; set `PI_HOST` to another executable to compare hosts. A pass here does not prove compatibility with a different host build.
- `context`: measures what each package adds to the first-turn context window. Current result: the whole collection costs about **1.7k tokens** on top of stock Pi, and 17 of 22 packages contribute nothing (they register hooks, commands, or UI patches only). Measured by capturing the actual request Pi sends to a local provider, against the pinned stock host, with machine state excluded. First-turn static cost only: runtime injections (tool results, hook-driven messages) are not measured. Not part of the `check` gate.

## Isolated sessions

Start with a command that needs no model or backend:

```sh
npm run dev -- pi-session-id
```

In the resulting Pi window, run `/session-id`. It should copy the isolated session ID to your OS clipboard. This intentionally changes the clipboard, not your Pi configuration.

The launcher creates a fresh, ignored `.dev/agent-*` directory, selects it as `PI_CODING_AGENT_DIR`, redirects session storage and all OS temp-directory variables into that directory, disables other extension/skill/theme/MCP/context resources and project config, and loads only the chosen package. It uses an in-memory session and offline mode. Session files remain in that directory for inspection; remove that individual directory when finished.

**Isolation is configuration isolation, not a security sandbox.** Other shell environment values are inherited, including any provider credentials. Extensions run with your user permissions. Clipboard, files, processes, and configured model requests retain their normal effects. No credentials or personal configuration are copied by the launcher.

Service-backed extensions are deliberately unconfigured. To test one, create its documented configuration **inside the isolated agent directory**, restart with that same directory manually, and provide your own endpoint/credentials. Do not point this repository's checks at your live agent directory just to make a test pass.

## Package catalogue

Each directory under `packages/` is an independently loadable, independently publishable Pi package with its own manifest, source, documentation, license, and provenance notice. Package names use the existing `@saifymatteo` scope.

### Session and model navigation

| Package | Purpose |
| --- | --- |
| [pi-session-id](packages/pi-session-id) | Copy the current session ID |
| [pi-session-finder](packages/pi-session-finder) | Search saved sessions across projects; open or fork them |
| [pi-session-nav](packages/pi-session-nav) | Jump between messages in the active context (compaction-aware) |
| [pi-session-rename](packages/pi-session-rename) | Generate session titles from the first prompt using configured models |
| [pi-session-retention](packages/pi-session-retention) | Inspect and manage stored sessions; review deletion behavior before use |
| [pi-model-go](packages/pi-model-go) | `/model-go`: cost-aware model picker with Go-plan pricing and intelligence scores |

### Transcript and terminal UI

| Package | Purpose |
| --- | --- |
| [pi-compact-tools](packages/pi-compact-tools) | Group consecutive tool calls into one collapsible card |
| [pi-clipboard-image](packages/pi-clipboard-image) | Attach clipboard images or copied image files (Alt+V) |
| [pi-codeblock-borders](packages/pi-codeblock-borders) | Render code fences as rules with titles, line numbers, and highlights |
| [pi-user-image-previews](packages/pi-user-image-previews) | Collapsible inline previews for newly submitted attachments |
| [pi-claude-usage](packages/pi-claude-usage) | Show Claude 5h/7d subscription usage in the footer |
| [pi-prestart-working](packages/pi-prestart-working) | Labelled "Working" spinner while `before_agent_start` hooks run |

### Tools and service adapters

| Package | Purpose |
| --- | --- |
| [pi-bg-bash](packages/pi-bg-bash) | Add background execution to the built-in bash/powershell tools |
| [pi-wait](packages/pi-wait) | Join background jobs (shell:/agent:) with lease-based delivery |
| [pi-codegraph](packages/pi-codegraph) | CodeGraph CLI adapter: explore tool plus index auto-init/sync |
| [pi-zvec](packages/pi-zvec) | Workspace search via the zg CLI: exact, lexical, semantic, hybrid |
| [pi-decisions](packages/pi-decisions) | Agent-facing classify tool backed by configured Decisions endpoints |
| [pi-tts](packages/pi-tts) | Generate WAV files through an OpenAI-compatible speech endpoint |
| [pi-vision](packages/pi-vision) | Describe images for text-only models via a configured vision chain |

### Environment and local observability

| Package | Purpose |
| --- | --- |
| [pi-load-pi-dotenv](packages/pi-load-pi-dotenv) | Load the agent-local .env into the environment for tool subprocesses |
| [pi-root-guard](packages/pi-root-guard) | Block agent writes into the Pi and Claude config roots |
| [pi-skill-usage-log](packages/pi-skill-usage-log) | Log which skills were actually used; `/skill-usage` summary |
| [pi-tool-usage-log](packages/pi-tool-usage-log) | Passive log of tool executions (names and status, never contents) |

## Individual and collection loading

For a development session with your existing configuration (not isolated):

```sh
pi -e ./packages/pi-session-id
```

Do not do this while an agent directory also autoloads a copy of the same extension: local paths and package paths are different resource identities, so duplicate commands/hooks may load. The isolated launcher avoids that collision.

The root is also an installable collection package. Once the Git remote exists, the whole collection installs in one step:

```sh
pi install git:github.com/saifymatteo/pi-extensions
pi install npm:@saifymatteo/pi-extensions   # after the first root release
```

The root manifest explicitly lists every package, matching the monorepo collection pattern. **Loading the root enables all listed resources**, including shell overrides, guardrails, UI patches, logging, and session housekeeping. It is not the recommended first test. Impact is small and measured: loading everything adds about 1.7k tokens to the first-turn context window on stock Pi; only bg-bash, zvec, codegraph, wait, and vision contribute — the rest register hooks, commands, or UI patches that cost nothing until used. Pi's package resource filters can select only particular root entrypoints. Prefer one package at a time while evaluating compatibility, and do not combine the root collection with individually installed packages from this repository: they are different package identities, so commands and hooks can duplicate.

Configuration paths are unchanged by packaging: for example, many adapters read `<agent-dir>/extensions/<name>.json`, not a config next to the package source. Examples are inert files for manual review, never automatically installed settings. Loading the dotenv extension before service adapters matters when config references environment variables; the root manifest places it first.

## External components stay external

| Component | Relationship to this collection |
| --- | --- |
| [`@saifymatteo/pi-orchestrator`](https://github.com/saifymatteo/pi-orchestrator) | Separate package/repository; async-work coordination is an integration contract, not vendored code |
| [`@saifymatteo/pi-atelier`](https://github.com/saifymatteo/pi-atelier) (fork of [michaelmjhhhh/pi-atelier](https://github.com/michaelmjhhhh/pi-atelier)) | Separate package; competing UI patches (including codeblock rendering) need integration testing |
| [`@saifymatteo/pi-agent-ask`](https://github.com/saifymatteo/pi-agent-ask) (fork of [alexshpunt/pi-agent-ask](https://github.com/alexshpunt/pi-agent-ask)) | Separate package, loaded independently |
| [`@saifymatteo/pi-x-ide`](https://github.com/saifymatteo/pi-x-ide) (fork of [balaenis/pi-x-ide](https://github.com/balaenis/pi-x-ide)) | Separate package, loaded independently; UI patches can overlap collection patches |
| [`@saifymatteo/Pi-Bolt`](https://github.com/saifymatteo/Pi-Bolt) (fork of [opensec-git/Pi-Bolt](https://github.com/opensec-git/Pi-Bolt)) | Host fork; one of the compatible `pi` executables that can load these packages. UI patches are host-version-sensitive |
| External CLIs and provider dependencies | Install independently where needed; package documentation lists prerequisites |

## Architecture and deliberate limits

```text
packages/<extension>/
  package.json       # explicit Pi entrypoint
  README.md          # behavior, configuration, prerequisites, caveats
  NOTICE.md          # licensing and provenance
  src/index.ts       # existing extension implementation
  src/lib/           # only helpers needed by this package, where applicable
  examples/          # sanitized, inert examples where applicable
scripts/             # boundary checks, isolated sessions, host smoke
test/                # test-only TS loader and collection behavior checks
inventory.json       # inclusion/exclusion map
```

Small helpers live inside the dependent packages that need them, so each package is self-contained with no unpublished shared-runtime package. Tool usage includes the skill dialog implementation as a sidecar, but only its own entrypoint is loaded. This duplication is an explicit tradeoff, not a recommended permanent shared-library design.

Implementation behavior is preserved unless explicitly documented; this is packaging work, not a rewrite. Known source limitations remain, including root-guard shell heuristic false positives and bypasses. UI prototype/layout patches are host-version-sensitive; broad peer ranges do not prove broad compatibility. Existing destructive or network behavior is not made safe simply by packaging it.

## Releasing a package

1. Bump the changed package's `version` in its manifest.
2. Tag `&lt;package&gt;-v&lt;version&gt;` (for example `pi-session-id-v0.1.0`) and push the tag. GitHub Actions typechecks, runs all checks, and publishes that one package to npm via trusted publishing ([publish.yml](.github/workflows/publish.yml)). For the whole collection, bump the root manifest version and tag `pi-extensions-v&lt;version&gt;` instead.
3. One-time setup per package (and once for the root): on npmjs.com, connect the package to this repository for trusted publishing. The first publish of a new package name may require a one-time token-based publish before OIDC can take over.
4. If an older copy of an extension is already loaded from loose files in an agent directory, remove it when adopting the package; local paths and package identities are different resources, and running both can duplicate commands and hooks.

Inspired by [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions): independently installable capabilities, separate from personal machine configuration. Its implementation and release machinery were not copied.

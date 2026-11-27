# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

### Added

- pi-cell-actions (new): hover a paragraph, list, heading, code block or table of a message, or a tool call, in the fullscreen transcript for a `⋯` menu that copies it (tables as Markdown, TSV or CSV; tools as input or output) and runs `bash`/`sh`/`zsh` blocks after a confirmation. Works on stock Pi and Pi-Bolt.
- pi-compact-tools: a grouped tool card tells pi-cell-actions which calls it draws and which call is under the pointer, so its menu copies one call or the whole group.

## [0.1.28] - 2026-11-26

### Added

- pi-x-ide: `sendContext` (`Send context` in `/ide settings`) turns IDE context off by default for every session; `/ide skip` still toggles it per session.

## [0.1.27] - 2026-11-25

### Fixed

- pi-clipboard-image: image paths and `[Image #N: original …]` resize notes move from the user message to a custom message.

## [0.1.26] - 2026-11-25

### Added

- `/pi-extensions` (collection only): pick any loaded package's settings; `/pi-extensions settings` turns packages on or off.
- **Breaking:** hyphenated commands became subcommands: `/codegraph init|sync|status|unlock`, `/zvec init|sync|status`, `/orchestrator tools`, `/ask settings`. The `/session-*` commands keep their names because `/session` is a Pi built-in.
- `/<command> settings` dialogs (modelled on pi-blackhole): `/ide`, `/codegraph`, `/zvec`, `/9router`, `/vision`, `/orchestrator`, plus pi-atelier Settings → Advanced…. Each lists every simple setting with Global / Project scope where the package reads a project file; lists and model chains stay JSON-only.
- Every package with a JSON config creates its global `<agent-dir>/extensions/<name>.json` once when missing: `$schema` plus defaults (pi-9router, pi-atelier, pi-orchestrator, pi-x-ide; pi-codegraph, pi-zvec and pi-agent-ask already did), or `$schema` only where a model must be chosen (pi-session-rename, pi-vision, and `service-models.json` for pi-decisions and pi-tts). Existing files are never overwritten and project files are never created.
- pi-x-ide: `/ide skip` or a click on the IDE widget pauses IDE context until toggled again; `zedNested: "auto"` attaches to a Zed window opened below Pi's working directory.

### Fixed

- pi-x-ide: `/ide` attaches to a Zed window opened below Pi's working directory.

## [0.1.25]

### Added

- Every package with a JSON config ships a JSON Schema under `schemas/`; add `"$schema": "https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/<package>/schemas/<name>.schema.json"` for editor completion and descriptions.

### Changed

- pi-atelier, pi-x-ide and pi-orchestrator user configs live in `<agent-dir>/extensions/` and move there automatically on first load.
- pi-atelier, pi-x-ide, pi-codegraph and pi-zvec project configs live in `.pi/extensions/`; the old project path is still read when the new one is absent.
- pi-9router removes the retired `@haoyiyin/9router` config after migrating it.

### Fixed

- pi-x-ide: IDE context paths are relative to Pi's working directory, or absolute when the file is outside it.

## [0.1.24]

### Added

- pi-x-ide: the file and lines open in VS Code, JetBrains, Neovim, or Zed reach the agent as an IDE Context message; Zed works from any terminal. If you also installed `npm:@saifymatteo/pi-x-ide`, remove one of them.

### Changed

- `pi-x-ide` is forked from balaenis/pi-x-ide (Apache-2.0). The upstream license is retained in `packages/pi-x-ide/LICENSE.APACHE` and still covers the upstream portions; saifymatteo's changes from 1.22.0 onward are AGPL-3.0-only.

## [0.1.23]

### Added

- Disable individual packages with `disabled` in `<agent-dir>/extensions/pi-extensions.json`. A JSON Schema ships at `schemas/pi-extensions.schema.json`. Without the file, every package loads.

### Changed

- pi-atelier: every Status Rail segment and Sidebar panel can now be hidden; nothing is required. Hiding every Sidebar panel collapses the sidebar.

### Fixed

- pi-atelier: saving settings keeps a symlinked `pi-atelier.json` linked instead of replacing it with a local copy.

## [0.1.22]

### Added

- pi-atelier: status rail footer, copy-friendly composer, and live activity sidebar join the collection. It replaces the footer and editor; if you also installed `npm:@saifymatteo/pi-atelier`, remove one of them.

## [0.1.21]

### Added

- pi-agent-ask: `ask_user` / `wait_for_answers` structured questions join the collection. If you also installed `npm:@saifymatteo/pi-agent-ask`, remove one of them.

## [0.1.20]

### Added

- pi-orchestrator: agent orchestration (`delegate` tool, fleet panel) joins the collection. If you also installed `npm:@saifymatteo/pi-orchestrator`, remove one of them.

## [0.1.19]

### Added

- pi-claude-usage: shows the weekly Fable window (`seven_day_overage_included`) when Claude reports it.

## [0.1.18]

### Fixed

- pi-clipboard-image: appended image paths keep their `[Image #N]` number after an earlier image is removed.

## [0.1.17]

### Changed

- pi-prestart-working: the spinner now reads `Loading extension: <name>`.

## [0.1.16]

### Added

- pi-draft: autosave the unsent prompt per folder and restore it on the next launch; footer status and Alt+S to save now.

### Fixed

- pi-codeblock-borders: restore decorated code-block rules on Pi-Bolt's optimized renderer; retain older Pi compatibility.

## [0.1.15]

### Fixed

- pi-zvec: stop reporting successful empty-workspace indexing as a sync failure.

## [0.1.14]

### Fixed

- pi-zvec: support zg 0.3's command syntax and native Windows executable.

## [0.1.13]

### Fixed

- pi-session-rename: reasoning models no longer fail titles with `length` (4,096-token budget with thinking on), and `fallbackModels` now also cover failed replies.

## [0.1.12]

### Fixed

- pi-session-rename no longer blocks Pi on the herdr CLI: tab mirroring runs in the background.

## [0.1.11]

### Fixed

- pi-9router no longer blocks Pi's startup on the router's `/v1/models`: it registers cached models at once and refreshes in the background.

## [0.1.10]

### Added

- `pi-9router`: 9Router provider driven entirely by the router's own `/v1/models` endpoint (with `fetch`/`search`/`transcribe` tools), replacing the third-party `@haoyiyin/9router` package and dropping its external model-catalog dependencies (modelgrep.com, models.dev, opencode zen).

### Changed

- `pi-9router` config is split by secret: `extensions/9router.json` holds the base URL and options (dotfile-versionable, no key), while the API key lives in `auth.json` as pi's standard 9router login credential; the login flow, migration from `haoyiyin/9router.json`, and the bundled tools all follow.
- pi-vision and pi-session-rename no longer depend on another extension for model access, and their configs use pi-blackhole's model shape: `model` plus `fallbackModels`, each `{"provider", "id", "thinking"?, "baseUrl"?}`, with the key from `auth.json`. Old string specs still load. pi-vision stops reading `saifymatteo/9router.json`, which left 9router candidates without a base URL.

## [0.1.9]

### Fixed

- Deliver image descriptions through chat endpoints that stream by default instead of failing every image with a JSON parse error (pi-vision).
- Survive Windows machines where the process inventory takes 20s+: startup registration and session/background-job process scans no longer fail, so freshly started instances register and "no verifiable session registration" deferrals stop (pi-session-retention, pi-bg-bash).
- Stop mistaking non-Pi tooling whose command line merely mentions a `pi`/`pi-bolt` path (e.g. Hindsight deepen jobs) for unregistered Pi instances that blocked /session-cleanup (pi-session-retention).

## [0.1.8]

### Added

- Page and jump with Page Up/Page Down and Home/End in Session Trash, session search, session navigation, and /model-go.

### Fixed

- Group Trash folders by the stable project segment so partially cached directories never split one project across several headers; the cached working directory provides the header label and legacy pre-grouping cache records re-extract once to supply it.

## [0.1.7]

### Added

- Preview trashed sessions in place with Enter, scroll read-only conversation excerpts, and switch between family members. Messages use Pi's themed Markdown rendering with highlighted code blocks and isolated formatting per excerpt. Ctrl+R requests a confirmed whole-family restore from either search or preview; Esc returns from preview without losing the search.
- Support Page Up/Page Down and Home/End in Session Trash: page through search results and previews, and jump straight to the first or last family or to the preview's top and bottom.
- Group Session Trash families under their originating project directories using session search's grouping: stable per-project groups (never split by partially cached working directories), folder labels prefer the cached working directory, and a fixed header above the scrolling rows tracks the group at the top of the viewport like session search.
- Open Session Trash before transcript indexing finishes, enrich search in the background, and reuse guarded metadata caches for unchanged files. Closing the picker cancels indexing; stale or unsafe metadata falls back to filenames without weakening restore or purge validation.
- Clean unrelated inactive session families while other Pi instances stay open, protecting registered open sessions and coordinating session changes across windows. Unregistered or unverifiable instances still defer maintenance.

### Fixed

- Wait for in-flight automatic cleanup when opening Session Trash or requesting explicit cleanup, instead of requiring a retry after reload; retain lock and shutdown safeguards.
- Separate Trash preview UI from transcript text with fixed muted project metadata, ruled sections, message-body rails, and a fixed excerpt-status strip. Preserve blue/yellow bold role headers without a user-message background.
- Accept OS pseudo-processes with PID 0, such as Windows System Idle Process, instead of incorrectly deferring session registration and cleanup previews.

## [0.1.6]

### Fixed

- Keep Compact Tools activity within the current message boundary instead of updating a previous request's card.

## [0.1.5]

### Added

- Include release notes for the collection and all 23 standalone extensions in Pi 1.5.0's Extension Updates.
- Add an interactive `/bg` manager with live output, running-job status, and separate confirmed graceful-stop and force-kill actions.

### Fixed

- Verify background-process identities and tracked descendants during cleanup, retaining survivors for retry without duplicating completion delivery.

## [0.1.4]

### Fixed

- Avoid startup pauses by deferring session retention maintenance and CodeGraph/zvec initialization.

## [0.1.3]

### Fixed

- Classify the collection as both an extension and a skill package in the Pi package gallery.

# Package release notes

Keep `CHANGELOG.md` at the root of the collection and every standalone package, included in each manifest's `files` list. Pi 1.5.0 discovers that filename automatically; no runtime hook or `pi.changelogPath` override is needed.

Record user-visible changes under `## [Unreleased]` in the affected package. Summarize collection-visible changes in the root changelog as well; standalone users read their package's notes, while collection users read the root notes.

At release, move the changes into a `## [x.y.z]` section matching that package's new manifest version and leave an Unreleased section above it. Keep released versions unique, newest first, and grounded in release tags; leave already published entries intact. Versions change as part of a requested release, not just to activate changelog display.

Pi records a package's version silently on first discovery and shows newer released entries on a fresh launch after a version increase, not on `/reload`. Unreleased entries are ignored; `/changelog` shows Pi's own notes, not package notes.

## Package JSON config

Every package that reads a JSON config follows one layout:

- User file: `<agent-dir>/extensions/<name>.json`. When it is missing and a file exists at an older location, move it once on load: write the old file's contents (following a symlink) to the new path, then remove the old path (the link itself, never its target). Notify or log one line naming both paths; a failed move leaves the old file in place and reads it for that session.
- Auto-create: when the user file is missing (after any legacy move, and with no legacy file left waiting), create it once on load with `$schema` first, then every default; a package without usable defaults (a required model or provider) writes only `$schema` plus any empty container its loader needs. Write with `flag: "wx"` so an existing file is never overwritten, and ignore a failed write (defaults stay in memory). Never create project files. Omit a default that would mask an environment fallback (pi-9router's empty `baseUrl` over `ROUTER_API_BASE`). A package test asserts the created content and that an existing file is kept.
- Project file: `<cwd>/.pi/extensions/<name>.json`, read only when the project is trusted where the package already gates on trust. Read an older project path only as a fallback; never move files inside a user's repo.
- Schema: hand-written `packages/<pkg>/schemas/<name>.schema.json` (draft 2020-12), listed in the manifest `files`. Its `$id` and the `$schema` value users write is the unversioned `https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/<pkg>/schemas/<name>.schema.json`, matching the root `schemas/pi-extensions.schema.json`; it needs no bump at release. Every property carries a `description`, and a `default` when one exists.
- Runtime: the loader accepts and ignores a top-level `$schema`. A package that saves its config sets `$schema` to that URL only when the key is absent and keeps any existing value; the URL is a constant, never read from `package.json`. Exception: pi-orchestrator also replaces a version-pinned jsdelivr URL that its released versions wrote.
- Drift: a package test asserts that the schema's top-level properties equal the default-config keys plus `$schema`. Schemas are never a runtime validation gate.
- `service-models.json` is shared by pi-decisions and pi-tts; each ships an identical copy of its schema, and `scripts/check-packages.mjs` asserts the copies match.

## Commands

One command per package, with subcommands: `/codegraph init`, not `/codegraph-init`. Register a single `pi.registerCommand("<name>")`, dispatch on the first word of `args`, list every subcommand in `getArgumentCompletions`, and answer an unknown or missing subcommand with a usage line (unless the bare command already has a job, as `/orchestrator` toggles). Renames drop the old name without an alias and are listed in the changelog. Exception: a name that would sit under a Pi built-in (`/session` is built in, so the `/session-*` commands stay hyphenated).

The root collection adds `collection/pi-extensions.ts` (never a standalone package): `/pi-extensions` opens a picker of loaded packages' settings commands (`SETTINGS_COMMANDS`), and `/pi-extensions settings` edits `disabled` in `pi-extensions.json`. When a package gains a settings command, add it to `SETTINGS_COMMANDS`; `check-packages` keeps the hub's `PACKAGES` list equal to `inventory.json`.

## Settings dialogs

Every package whose JSON config has simple fields exposes them in a `/<command> settings` dialog, modelled on pi-blackhole's `/blackhole settings`.

- Simple field: a boolean, enum, number or short string at the top level or one object level down (pi-9router `tools.fetch`). Arrays, maps, model chains, keymaps and provider lists stay JSON-only; the dialog's `footnote` names them and their file. Deprecated keys get no row.
- Dialog: copy `packages/pi-x-ide/src/settings-dialog.ts` byte for byte into `<pkg>/src/settings-dialog.ts` and import it lazily inside the command handler, so pi-tui stays off the startup import graph. `scripts/check-packages.mjs` fails when a copy drifts; edit the pi-x-ide file, then copy it to every package that has one. A package using it lists `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` as `*` peers.
- Scopes: the dialog opens on a Global / Project picker when the package reads a project file (`jsonFileScope` for plain JSON), and goes straight to the fields when it reads only the global file. A package that selects one file instead of merging (pi-orchestrator) passes that file as its only scope with `inheritsGlobal: false`.
- Command: `/<command> settings`, with `settings` in `getArgumentCompletions`. A package whose bare command already does something keeps it and adds the subcommand (`/orchestrator` still toggles). pi-atelier reaches the same dialog from its menu (Settings → Advanced…) because `/atelier` is a menu.
- Fields: one exported `SETTINGS_FIELDS`-style list per package, with each description adapted from the schema. Set `requiresReload` on fields read only at startup; the save notice then says to `/reload`.
- Tests: `test/settings-dialogs.test.mjs` drives each standalone dialog with real keys and asserts every simple schema property has a row. Packages with their own runner (pi-x-ide, pi-orchestrator, pi-atelier) carry the same two assertions in their tests. Adding a simple schema property without a row fails those tests.

Current dialogs: `/ide settings`, `/codegraph settings`, `/zvec settings`, `/9router settings`, `/vision settings`, `/orchestrator settings`, pi-atelier Settings → Advanced…. pi-agent-ask keeps its own list at `/ask settings`. No dialog: pi-session-rename (only model chains and a deprecated key), pi-decisions and pi-tts (`service-models.json` is a provider list).

## Agent skills

### Issue tracker

GitHub Issues in `saifymatteo/pi-extensions`; read `docs/agents/issue-tracker.md` before ticket or spec operations.

### Domain docs

Single-context; read `docs/agents/domain.md` before codebase exploration or terminology and architecture decisions.

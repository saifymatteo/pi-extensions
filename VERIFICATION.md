# Verification

## Verified in this workspace

Host: `1.4.0 (Pi-Bolt 1.0.7, win32-x64-jit, JIT on)`; Node.js `24.21.0`.

The latest verification run completed successfully:

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
npm test
npm run pack:check
npm run smoke
```

| Check | Result | What it establishes |
| --- | --- | --- |
| Dependency/lockfile refresh | Passed; npm reported 0 vulnerabilities | Workspace links match the current package list without lifecycle scripts or host-peer copies |
| Semantic typecheck | 0 errors across 39 TypeScript files | Extension sources checked with `tsc` against pinned host types (`@earendil-works/pi-coding-agent@1.4.0`, `pi-tui@1.4.0`), matching the current host |
| Collection/package checks | 22 packages, 39 TypeScript files passed | Explicit entrypoints, inventory completeness, parseable syntax, contained/resolvable imports, declared dependencies, AGPL-3.0-only + publishable manifests, example-only configuration filenames |
| Offline behavioral tests | 34 passed, 0 failed | Covered mocked/fixture behaviors including navigation, clipboard outcomes, retention safeguards, service selection, TTS output protection, async-work leases, CLI delegation, environment isolation, and UI data handling |
| npm package dry-run | 22 passed | Expected source/docs/example file lists; no archives created, no publication |
| Native host help/startup | 22 passed | Each package resolves imports and initializes through the host; a registered probe flag confirms that extension factories execute |

Runtime behavior of the collected extensions is preserved; deliberate divergences are two relative dialog imports relocated inside the session-retention package and 21 type-only fixes (assertions and annotations, required for `tsc` against the published host types) in six files. The compact renderer was read in chunks to avoid truncation. No source import points outside its own package.

Git is initialized on `main`, without a remote or initial commit. No GitHub repository or package release was created. All intentional file writes were inside this repository, aside from normal package-manager cache/log activity and the smoke temporary directories noted below.

## Safety issue discovered during evaluation

The initial help/startup run isolated the agent home but inherited the normal OS temp directory. The preserved bg-bash factory sweeps `pi-bg-*` job files older than 24 hours, so that run **may have removed stale job-output/status files** there. Whether any were removed was not established; absence of a pre-run inventory prevents claiming no effect.

The final launcher and smoke checks redirect `TMPDIR`, `TMP`, `TEMP`, and `PI_CODING_AGENT_SESSION_DIR` into their disposable agent home. Inherited environment values other than these overrides are passed through untouched. A regression test verifies these environment overrides.

## Not verified

- Actual interactive TUI appearance, resize/mouse handling, image protocols, real clipboard operations, and overlapping Atelier/other UI patches.
- Real CodeGraph/Zvec processes, retention's native process-discovery behavior, live model/classifier/TTS/vision endpoints, or network error handling against real services.
- Ordinary Pi, Oh My Pi, macOS, or Linux compatibility. Source claims and wildcard peers do not establish those guarantees.
- Complete regression coverage for the roughly 9,500-line source collection; typechecking uses `strict: false` and pinned 1.4.0 host types, so host API drift beyond that version is not caught.
- Redistribution clearance is now decided (AGPL-3.0-only) but publication has not happened: no git remote, no npm trusted-publisher configuration, and the model-go upstream clearance rests on the npm registry's MIT license field rather than a line-by-line audit.

## Known inherited limitations

The package READMEs identify source limitations rather than silently repairing them: finder Alt+I inserts `/find` instead of its registered `/session-global`; root-guard shell parsing can both over-block and miss writes; some adapters auto-create configuration/indexes on session startup; session retention can permanently purge already-approved expired Trash; service adapters and UI patches have their documented compatibility/privacy caveats.

Configuration isolation is not filesystem/process sandboxing. Provider credentials elsewhere in the inherited shell environment still exist; extension code retains the user's OS permissions.

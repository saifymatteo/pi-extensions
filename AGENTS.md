# Package release notes

Keep `CHANGELOG.md` at the root of the collection and every standalone package, included in each manifest's `files` list. Pi 1.5.0 discovers that filename automatically; no runtime hook or `pi.changelogPath` override is needed.

Record user-visible changes under `## [Unreleased]` in the affected package. Summarize collection-visible changes in the root changelog as well; standalone users read their package's notes, while collection users read the root notes.

At release, move the changes into a `## [x.y.z]` section matching that package's new manifest version and leave an Unreleased section above it. Keep released versions unique, newest first, and grounded in release tags; leave already published entries intact. Versions change as part of a requested release, not just to activate changelog display.

Pi records a package's version silently on first discovery and shows newer released entries on a fresh launch after a version increase, not on `/reload`. Unreleased entries are ignored; `/changelog` shows Pi's own notes, not package notes.

## Agent skills

### Issue tracker

GitHub Issues in `saifymatteo/pi-extensions`; read `docs/agents/issue-tracker.md` before ticket or spec operations.

### Domain docs

Single-context; read `docs/agents/domain.md` before codebase exploration or terminology and architecture decisions.

# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.3.0] - 2026-11-25

### Changed

- **Breaking:** `/zvec-init`, `/zvec-sync` and `/zvec-status` are now `/zvec init|sync|status`. The old names are gone.

### Added

- `/zvec settings`: Global / Project dialog for `autoInit`, `syncOnSettle` and `embedding`.

## [0.2.0] - 2026-11-25

### Added

- JSON schema for `zvec.json` (`schemas/zvec.schema.json`); the auto-created global config and the example include its `$schema` line, which the loader ignores.

### Changed

- Project overrides move to `<project-root>/.pi/extensions/zvec.json`. The older `.pi/zvec.json` is still read when the new file is absent and is never moved.

## [0.1.7]

### Fixed

- Treat zg's successful "No indexable files were found" output as an empty-workspace no-op instead of a missing-index failure.

## [0.1.6]

### Fixed

- Use zg 0.3's flag-based management commands and explicit search routes instead of legacy subcommands.
- Resolve the native zg executable on Windows so regex arguments bypass the npm command shim.

## [0.1.5]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.

## [0.1.4]

### Fixed

- Defer CLI checks, configuration, and index initialization until after session startup to avoid blocking Pi.
- Cancel stale initialization when the active session changes.

## [0.1.3]

### Fixed

- Classify the package as an extension in the Pi package gallery.
- Show the package screenshot as its gallery preview.

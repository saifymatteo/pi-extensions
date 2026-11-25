# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

### Added

- `/codegraph settings`: Global / Project dialog for `autoInit` and `syncOnSettle`.

## [0.2.0] - 2026-11-25

### Added

- JSON schema for `codegraph.json` (`schemas/codegraph.schema.json`); the auto-created global config and the example include its `$schema` line, which the loader ignores.

### Changed

- Project overrides move to `<project-root>/.pi/extensions/codegraph.json`. The older `.pi/codegraph.json` is still read when the new file is absent and is never moved.

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

# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

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

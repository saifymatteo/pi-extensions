# Changelog

Release notes are recorded from 0.20.1 onward. Earlier fork and upstream history: [saifymatteo/pi-atelier CHANGELOG](https://github.com/saifymatteo/pi-atelier/blob/main/CHANGELOG.md).

## [Unreleased]

### Changed

- Moved into the [pi-extensions](https://github.com/saifymatteo/pi-extensions) monorepo (`packages/pi-atelier`); the npm package name is unchanged. Issues and releases now live there.
- Changes from this release onward are AGPL-3.0-only. The upstream MIT notice is kept in `LICENSE.MIT` and still covers the upstream code; versions 0.20.2 and earlier remain MIT.
- Now also bundled in the all-in-one `@saifymatteo/pi-extensions` collection. Install either the collection or this package, not both.
- Requires Node.js 24 or newer (was 22.19).

### Fixed

- Fullscreen sidebar overlay handles report their bounds, matching the Pi-TUI 1.4 overlay API.

## [0.20.2] - 2026-11-18

- Give footer extension statuses distinct colors in display order: pink, green, gold, orange, purple, and cyan, repeating after six statuses. Keep dedicated rows, dim separators, wrapping, truncation, and `NO_COLOR` behavior.

## [0.20.1] - 2026-11-14

- Merge upstream v0.20.0 and the framed panel title-casing fix through `a799be1`, including the focused Sidebar, Framed/Minimal styles, per-file change counts, configurable resize shortcut, Plain text default, and development dependency security fix.
- Preserve the fork README, scoped package identity, dedicated and ordered extension-status rows, copy-friendly editor, footer coexistence, and path-flavor handling. Keep POSIX path expectations on Windows instead of adopting upstream's native-drive expectations.

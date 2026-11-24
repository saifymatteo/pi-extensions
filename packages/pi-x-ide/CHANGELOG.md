# Changelog

Release notes are recorded from 1.21.0 onward. Earlier fork history: [saifymatteo/pi-x-ide commits](https://github.com/saifymatteo/pi-x-ide/commits/main); upstream: [balaenis/pi-x-ide CHANGELOG](https://github.com/balaenis/pi-x-ide/blob/main/CHANGELOG.md).

## [Unreleased]

## [1.22.0] - 2026-11-24

### Changed

- Moved into the [pi-extensions](https://github.com/saifymatteo/pi-extensions) monorepo (`packages/pi-x-ide`); the npm package name is unchanged. Issues and releases now live there.
- Ships the Pi side only. The VS Code, JetBrains, and Neovim plugins stay on upstream releases; auto-install still targets the upstream VS Code extension.
- Changes from this release onward are AGPL-3.0-only. The upstream Apache-2.0 license is kept in `LICENSE.APACHE` and still covers the upstream code; versions 1.21.0 and earlier remain Apache-2.0.
- Now also bundled in the all-in-one `@saifymatteo/pi-extensions` collection. Install either the collection or this package, not both.
- The configuration schema moved to `schemas/pi-x-ide.schema.json` in this package; update the `$schema` URL in your `config.json`.
- Requires Node.js 24 or newer (was 26). Pi loads the TypeScript sources directly; there is no build step.

### Fixed

- Auto-install compares the installed VS Code extension against the latest upstream release (1.20.1), not this package's version, so it no longer reinstalls on every startup.

## [1.21.0] - 2026-11-24

Last release from [saifymatteo/pi-x-ide](https://github.com/saifymatteo/pi-x-ide), Apache-2.0.

### Added

- Zed is detected from any terminal, not only Zed's own: Pi attaches once Zed is running with this project open, re-checks every 5 seconds while disconnected, and disconnects when the project window closes or Zed quits.
- `/ide` connects to Zed when no IDE lock file matches, instead of warning.

### Fixed

- IDE context works with Pi 1.5.0+ runs started by an extension message.

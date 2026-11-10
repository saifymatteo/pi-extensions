# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

### Changed

- Resolve the 9router provider's credentials from `saifymatteo/9router.json` instead of `haoyiyin/9router.json`, matching the new `@saifymatteo/pi-9router` package that replaces `@haoyiyin/9router` (the login flow migrates the file automatically on its first launch).

## [0.1.5]

### Fixed

- Send `stream: false` on describe requests: gateways that stream by default returned `text/event-stream`, which broke `response.json()` with `JSON Parse error: Unexpected identifier "data"` and blocked every image.

## [0.1.4]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.

## [0.1.3]

### Fixed

- Classify the package as both an extension and a skill package in the Pi package gallery.
- Show the package screenshot as its gallery preview.

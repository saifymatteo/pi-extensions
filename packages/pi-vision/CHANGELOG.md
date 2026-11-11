# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.1.6]

### Changed

- Model entries in `vision-toolkit.json` are objects, matching pi-blackhole: `model` and `fallbackModels` take `{"provider", "id", "baseUrl"?, "apiKey"?, "protocol"?, "thinking"?}`. `thinking` is sent as `reasoning_effort` (capped at `high`) by the extension and the skill CLIs. `"provider/model-id"` strings, `fallbacks`, and the `providers` map still load.
- Stop reading other extensions' config files (previously `saifymatteo/9router.json`). Runtime-registered providers such as 9router resolve from the entry's `baseUrl` plus the `auth.json` credential, so pi-vision works without any other package installed.

### Fixed

- The skill CLIs no longer carry a previous candidate's `protocol` into a fallback candidate.
- `vision-doctor` masks `apiKey` values set on model entries.

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

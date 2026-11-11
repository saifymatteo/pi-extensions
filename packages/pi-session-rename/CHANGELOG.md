# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.1.7]

### Fixed

- Titles no longer fail with `length` on reasoning models: with thinking on, the output budget is 4,096 tokens (was 1,024), since a long prompt can make the model reason past 1,024 before answering.
- `fallbackModels` now cover failed replies too: an error, a reply cut off by the token limit, or one that is not title JSON tries the next entry, and the warning appears only when every entry fails. Previously fallbacks applied only when an earlier model had no credentials.

## [0.1.6]

### Fixed

- Herdr tab mirroring no longer blocks Pi: `herdr tab get`/`rename` run asynchronously in the background, one at a time and in order, instead of synchronously on session start and on every rename (up to 2 seconds each when herdr hung). Shutdown still waits for the original tab label to be restored.

## [0.1.5]

### Added

- Model entries are objects, matching pi-blackhole: `model` and `fallbackModels` take `{"provider", "id", "thinking"?, "baseUrl"?}`, so each model sets its own reasoning level. `"provider/model-id"` strings, `fallbacks`, and a top-level `thinking` still load.
- An entry with `baseUrl` is called directly over the OpenAI Chat Completions API with its provider's `auth.json` key, so titles work without the extension that registers the provider (e.g. pi-9router) being loaded.

## [0.1.4]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.

## [0.1.3]

### Fixed

- Classify the package as an extension in the Pi package gallery.
- Show the package screenshot as its gallery preview.

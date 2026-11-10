# Changelog

All notable changes to this package are documented here. Formats follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

### Added

- 9Router provider driven entirely by the router's own `/v1/models` endpoint (30-minute cached refresh, stale-cache fallback), replacing the third-party `@haoyiyin/9router` package and its external catalog dependencies (modelgrep.com, models.dev, opencode zen).
- Model `input` comes from the router's own `capabilities.vision` flag instead of regex guesses, so image capability is correct for every listed model.
- Display names are derived from model ids (the router does not advertise names).
- Bundled `fetch`/`search`/`transcribe` tools (vendored from the MIT-licensed upstream; see NOTICE.md), each individually disableable via a `tools` section in `<agent-dir>/saifymatteo/9router.json`.
- One-time config migration: an existing `haoyiyin/9router.json` is copied to `saifymatteo/9router.json` on first launch.

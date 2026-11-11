# Changelog

All notable changes to this package are documented here. Formats follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2]

### Fixed

- Never block Pi's startup on the router: models register at once from the cache (any age; empty only on the very first run) and `/v1/models` is refreshed in the background, re-registering when it answers. Previously a cache older than 30 minutes made startup wait on the router, up to the 15-second timeout when it hung.

## [0.1.1]

### Changed

- Config moved to `<agent-dir>/extensions/9router.json` — the same dotfile-symlinked directory other package configs use — and is now secret-free: base URL, `comboReasoning`, and tool toggles only.
- The API key is no longer stored in the config file: it is read from `auth.json`'s standard 9router login credential (chat already authenticated through it; the bundled tools now too), with `ROUTER_API_KEY` as an override. `/login` seeds the credential before its immediate re-register so models apply without a restart.
- Migration consumes both the `haoyiyin/9router.json` legacy file (retained — published pi-vision releases still read it) and the pre-release `saifymatteo/9router.json` intermediate (removed after), writing the secret-free config and seeding `auth.json`.
- The bundled tools register only when a base URL and a credential are both available at load time.

## [0.1.0]

### Added

- 9Router provider driven entirely by the router's own `/v1/models` endpoint (30-minute cached refresh, stale-cache fallback), replacing the third-party `@haoyiyin/9router` package and its external catalog dependencies (modelgrep.com, models.dev, opencode zen).
- Model `input` comes from the router's own `capabilities.vision` flag instead of regex guesses, so image capability is correct for every listed model.
- Display names are derived from model ids (the router does not advertise names).
- Bundled `fetch`/`search`/`transcribe` tools (vendored from the MIT-licensed upstream; see NOTICE.md), each individually disableable via a `tools` section in `<agent-dir>/extensions/9router.json`.
- Config is split by secret: `extensions/9router.json` holds the base URL and options (safe to version in dotfiles), while the API key lives in `auth.json` as pi's standard 9router login credential (`ROUTER_API_BASE` / `ROUTER_API_KEY` env vars override).
- One-time config migration: `haoyiyin/9router.json` (or the pre-release `saifymatteo/9router.json`) is converted to the new secret-free config with the API key seeded into `auth.json`; the `haoyiyin` file is retained for published pi-vision releases, the intermediate is removed.

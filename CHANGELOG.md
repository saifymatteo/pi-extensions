# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.1.9]

### Fixed

- Deliver image descriptions through chat endpoints that stream by default instead of failing every image with a JSON parse error (pi-vision).
- Survive Windows machines where the process inventory takes 20s+: startup registration and session/background-job process scans no longer fail, so freshly started instances register and "no verifiable session registration" deferrals stop (pi-session-retention, pi-bg-bash).
- Stop mistaking non-Pi tooling whose command line merely mentions a `pi`/`pi-bolt` path (e.g. Hindsight deepen jobs) for unregistered Pi instances that blocked /session-cleanup (pi-session-retention).

## [0.1.8]

### Added

- Page and jump with Page Up/Page Down and Home/End in Session Trash, session search, session navigation, and /model-go.

### Fixed

- Group Trash folders by the stable project segment so partially cached directories never split one project across several headers; the cached working directory provides the header label and legacy pre-grouping cache records re-extract once to supply it.

## [0.1.7]

### Added

- Preview trashed sessions in place with Enter, scroll read-only conversation excerpts, and switch between family members. Messages use Pi's themed Markdown rendering with highlighted code blocks and isolated formatting per excerpt. Ctrl+R requests a confirmed whole-family restore from either search or preview; Esc returns from preview without losing the search.
- Support Page Up/Page Down and Home/End in Session Trash: page through search results and previews, and jump straight to the first or last family or to the preview's top and bottom.
- Group Session Trash families under their originating project directories using session search's grouping: stable per-project groups (never split by partially cached working directories), folder labels prefer the cached working directory, and a fixed header above the scrolling rows tracks the group at the top of the viewport like session search.
- Open Session Trash before transcript indexing finishes, enrich search in the background, and reuse guarded metadata caches for unchanged files. Closing the picker cancels indexing; stale or unsafe metadata falls back to filenames without weakening restore or purge validation.
- Clean unrelated inactive session families while other Pi instances stay open, protecting registered open sessions and coordinating session changes across windows. Unregistered or unverifiable instances still defer maintenance.

### Fixed

- Wait for in-flight automatic cleanup when opening Session Trash or requesting explicit cleanup, instead of requiring a retry after reload; retain lock and shutdown safeguards.
- Separate Trash preview UI from transcript text with fixed muted project metadata, ruled sections, message-body rails, and a fixed excerpt-status strip. Preserve blue/yellow bold role headers without a user-message background.
- Accept OS pseudo-processes with PID 0, such as Windows System Idle Process, instead of incorrectly deferring session registration and cleanup previews.

## [0.1.6]

### Fixed

- Keep Compact Tools activity within the current message boundary instead of updating a previous request's card.

## [0.1.5]

### Added

- Include release notes for the collection and all 23 standalone extensions in Pi 1.5.0's Extension Updates.
- Add an interactive `/bg` manager with live output, running-job status, and separate confirmed graceful-stop and force-kill actions.

### Fixed

- Verify background-process identities and tracked descendants during cleanup, retaining survivors for retry without duplicating completion delivery.

## [0.1.4]

### Fixed

- Avoid startup pauses by deferring session retention maintenance and CodeGraph/zvec initialization.

## [0.1.3]

### Fixed

- Classify the collection as both an extension and a skill package in the Pi package gallery.

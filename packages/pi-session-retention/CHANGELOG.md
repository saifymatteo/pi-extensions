# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.1.6]

### Added

- Preview trashed sessions in place with Enter, scroll read-only conversation excerpts, and switch between family members. Messages use Pi's themed Markdown rendering with highlighted code blocks and isolated formatting per excerpt. Ctrl+R requests a confirmed whole-family restore from either search or preview; Esc returns from preview without losing the search.
- Support Page Up/Page Down and Home/End in Session Trash: page through search results and previews, and jump straight to the first or last family or to the preview's top and bottom.
- Group Session Trash families under their originating project directories, matching session search: folder headers use the cached working directory when known, the selected family's folder stays fixed above the scrolling list, and filtering keeps only folders with matches.
- Open Session Trash before transcript indexing finishes, enrich search in the background, and reuse guarded metadata caches for unchanged files. Closing the picker cancels indexing; stale or unsafe metadata falls back to filenames without weakening restore or purge validation.
- Clean unrelated inactive session families while other Pi instances stay open, protecting registered open sessions and coordinating session changes across windows. Unregistered or unverifiable instances still defer maintenance.

### Fixed

- Wait for in-flight automatic cleanup when opening Session Trash or requesting explicit cleanup, instead of requiring a retry after reload; retain lock and shutdown safeguards.
- Separate Trash preview UI from transcript text with fixed muted project metadata, ruled sections, message-body rails, and a fixed excerpt-status strip. Preserve blue/yellow bold role headers without a user-message background.
- Accept OS pseudo-processes with PID 0, such as Windows System Idle Process, instead of incorrectly deferring session registration and cleanup previews.

## [0.1.5]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.

## [0.1.4]

### Fixed

- Schedule automatic maintenance outside the awaited session-start handler; defer launch while the agent is busy.
- Offer `/session-cleanup` for first approval without interrupting startup, retaining store locking, protected sessions, and shutdown draining.

## [0.1.3]

### Fixed

- Classify the package as an extension in the Pi package gallery.
- Show the package screenshot as its gallery preview.

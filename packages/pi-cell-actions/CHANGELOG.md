# Changelog

## [Unreleased]

## [0.1.2] - 2026-11-27

### Changed

- Builds and typechecks against Pi 1.6.1 host types (read-only `render()` lines and related type changes); no behaviour change.

## [0.1.1] - 2026-11-27

### Changed

- First release published from GitHub Actions through npm trusted publishing; no code changes.

## [0.1.0] - 2026-11-27

### Added

- Hover a paragraph, list, heading, code block or table of a message, or a tool call, in the fullscreen transcript for a yellow `⋯` badge; hover the badge for copy actions. Tables copy as Markdown, TSV or CSV; tool cards copy their input or output, per call or for a whole pi-compact-tools group. The Esc key closes an open menu.
- `bash`, `sh`, `shell` and `zsh` code blocks get a **run** action: after a confirmation, the output appears below as a message the model sees on its next turn.

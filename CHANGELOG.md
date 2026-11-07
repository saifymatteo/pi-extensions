# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

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

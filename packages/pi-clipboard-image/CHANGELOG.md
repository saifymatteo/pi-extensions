# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

### Fixed

- Image paths and resize notes go in a separate custom message after the prompt, so the user message shows only what was typed. Each note is labelled with its marker (`[Image #2: original 2704x694, displayed at 2000x513. …]`) instead of core's unlabelled `[Image: …]`. Steer and follow-up messages sent while the agent is running keep them inline.

## [0.1.5]

### Fixed

- Label appended image paths with their `[Image #N]` marker number, so removing an earlier image no longer points a later marker at the wrong path.

## [0.1.4]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.

## [0.1.3]

### Fixed

- Classify the package as an extension in the Pi package gallery.
- Show the package screenshot as its gallery preview.

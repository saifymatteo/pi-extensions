# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.3.0] - 2026-11-25

### Added

- A missing `extensions/service-models.json` is created once as `$schema` plus empty `providers`; the tool stays disabled until a TTS model is added. An existing file is never overwritten.

## [0.2.0] - 2026-11-25

### Added

- Ship `schemas/service-models.schema.json` for editor validation of `service-models.json`; the example registry sets `$schema`.

## [0.1.4]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.

## [0.1.3]

### Fixed

- Classify the package as an extension in the Pi package gallery.
- Show the package screenshot as its gallery preview.

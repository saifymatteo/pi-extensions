# Changelog

Release notes are recorded from 0.1.3 onward.

## [Unreleased]

## [0.1.5]

### Fixed

- Raise the Windows process-command timeout from 15s to 60s: machines where the `Win32_Process` WMI enumeration takes 20s+ failed background-job identity scans and stop/kill bookkeeping.

## [0.1.4]

### Added

- Include package release notes in Pi 1.5.0's Extension Updates.
- Add an interactive `/bg` list, bounded live output, and a running-job footer count.
- Provide separate confirmed graceful-stop and force-kill actions, with no automatic escalation.

### Fixed

- Verify process creation identities and tracked descendant exit, retaining known survivors for retry even after a launcher exits.
- Isolate Windows job consoles so graceful Ctrl+C can run Bash and PowerShell cleanup handlers without interrupting Pi.

## [0.1.3]

### Fixed

- Classify the package as an extension in the Pi package gallery.
- Show the package screenshot as its gallery preview.

# Changelog

## [Unreleased]

### Added

- JSON schema for `pi-agent-ask.json` (`schemas/pi-agent-ask.schema.json`) for editor completion and validation. Saved configs start with its `$schema` URL; an existing `$schema` is kept, and the loader ignores the key.

## [1.2.2] - 2026-11-24

### Changed

- Moved into the [pi-extensions](https://github.com/saifymatteo/pi-extensions) monorepo (`packages/pi-agent-ask`); the npm package name is unchanged. Issues and releases now live there.
- Changes from this release onward are AGPL-3.0-only. The upstream MIT notice is kept in `LICENSE.MIT` and still covers the upstream code; versions 1.2.1 and earlier remain MIT.
- Now also bundled in the all-in-one `@saifymatteo/pi-extensions` collection. Install either the collection or this package, not both.
- Requires Node.js 24 or newer.

## [1.2.1]

- Report foreground and background question forms as blocked in Herdr GUI through native Pi program status, including background remounts.
- Preserve the existing blocked lifecycle events for Herdr TUI compatibility.

## [1.2.0]

- Keep long inline and file-backed proposals readable in a bounded, styled preview pane, with the options and footer outside the paged content.
- Add PageUp/PageDown and Home/End navigation, a visible row range, and layout recalculation on terminal resize.
- Support hover-targeted mouse-wheel scrolling in fullscreen mode: scroll the preview or transcript independently without changing keyboard focus or spilling past preview boundaries.
- Preserve native answer/note editor shortcuts and support the same preview navigation in foreground, background, and recovered forms.

## [1.1.2]

- Rewrite the README to credit the upstream projects and their original READMEs, listing only this fork's changes.

## [1.1.1]

- Reduce agent context with shorter tool descriptions and field-local guidance while preserving the API and interactive features.
- Guide agents to use preview files for long content already on disk instead of copying it into tool calls.
- Add regression checks for guidance and schema sizes.

## [1.1.0]

- Reuse compatible clipboard extensions inside Ask answers and notes through optional provider events, with built-in clipboard reading as fallback when no provider is loaded.
- Keep Alt+V and Ctrl+Alt+V available inside Ask when Pi's image-paste binding is disabled, without changing normal chat shortcuts.
- Validate provider images and clean up pending reads so late replies cannot attach to a closed editor.

## [1.0.1]

- Align image integration coverage with the trimmed fork's two-tool surface.
- Publish the post-rebase standalone fork with npm provenance.

Notable changes to `@saifymatteo/pi-agent-ask` are recorded here.

This project is a trimmed fork of [alexshpunt/pi-agent-ask](https://github.com/alexshpunt/pi-agent-ask); see that repository for the history of the upstream project.

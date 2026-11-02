# pi-session-nav

Navigate visible user and assistant messages on the active conversation branch without adding transcript entries.

## Running locally

From the monorepo root:

```sh
pi -e ./packages/pi-session-nav
```

**Warning:** this extension uses your existing Pi resources and settings unless you load it in an isolated home (see the root README). Do not load two copies of the same extension (for example an older standalone file alongside this package): commands and hooks can duplicate. The package never installs or relocates personal settings.

## Commands and shortcuts

- `/session-nav` or `Alt+O` — opens the navigator.
- Up/Down to select, Enter to jump, Escape/Ctrl+C to cancel.

## Settings and storage

No settings file. The last selected message ID is kept in module memory only. Compacted-away and textless/tool-only messages are excluded.

## Privacy and operations

Reads the in-memory branch and rendered transcript; does not write files, send model requests or change the branch.

## Compatibility

Node.js >=24 for development checks; run extensions through Pi's TypeScript loader. Host imports are wildcard peers, not bundled runtime copies. Jumping relies on Pi's fullscreen TUI internal layout/component properties, not a stable public scrolling API. Regular terminal mode can open the dialog but cannot jump; a warning is shown. Runtime upgrades may break message matching or scrolling.

See [NOTICE.md](NOTICE.md) for provenance. Tests use the monorepo's TypeScript dev dependency and VM loader; they do not contact services or write to user-home resources.

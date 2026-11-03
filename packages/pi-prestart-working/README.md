# @saifymatteo/pi-prestart-working

## Purpose and registrations

Shows Pi's native "Working" spinner, labelled with the extension currently blocking (e.g. `⠙ Loading hindsight-coding-agents`), while `before_agent_start` hooks run. Pi only raises its working indicator at `turn_start`, so slow handlers otherwise leave the UI silent. No tools, commands, or configuration.

## Compatibility and safety

Patches `ExtensionRunner.prototype.emitBeforeAgentStart` once per process (guarded by a global symbol, so `/reload` does not double-wrap) and relies on the runner's internal `extensions`, `handlers`, and `uiContext` shapes. These are host internals, not a public API: a host release that renames them breaks the patch. The label is the nearest `package.json` name (scope dropped), else the file name. No-op without UI.

Imported host APIs are declared as peer dependencies and supplied by the Pi host. A `*` peer range describes host resolution, not a guarantee of compatibility with every release.

## Running locally

From the repository root:

```sh
pi -e ./packages/pi-prestart-working
```

Follow the [root README](../../README.md#isolated-sessions) to avoid loading an existing copy of the extension.

## Status

Part of the [pi-extensions](../../README.md) collection. No personal settings or credentials are included; see [NOTICE.md](NOTICE.md) for licensing and provenance.

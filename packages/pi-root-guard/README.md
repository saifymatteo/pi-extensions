# Agent configuration root guard

Blocks selected write/edit and simple bash writes into Pi and Claude configuration roots.

## Try locally

From the repository root:

```sh
pi -e ./packages/pi-root-guard
```

This uses your normal personal resources unless you isolate the agent home. Follow the [root README](../../README.md#isolated-sessions) to avoid loading an existing copy of the extension. Nothing is installed globally. 

## Configuration and requirements

Uses PI_CODING_AGENT_DIR, CLAUDE_CONFIG_DIR, and optional PI_GUARDRAIL_TEMP. Allows managed Pi subdirectories (agents, extensions, skills, npm, git, temp) and selected Claude working directories.

## Compatibility and safety

A guardrail, NOT a filesystem sandbox. Shell parsing is heuristic; arbitrary subprocess writes, aliases/symlinks, and unhandled tools may bypass it. The preserved source also has false positives: `echo "not a redirection > settings.json"` inside a guarded root is treated as a possible write, despite the quoted `>`. Existing error handling is preserved. Use OS permissions/sandboxing for a security boundary.

Imported host APIs are declared as peer dependencies and supplied by the Pi host. A `*` peer range describes host resolution, not a guarantee of compatibility with every release. See root verification notes for what was actually exercised.

## Status

Part of the [pi-extensions](../../README.md) collection. No personal settings or credentials are included; see [NOTICE.md](NOTICE.md) for licensing and provenance.

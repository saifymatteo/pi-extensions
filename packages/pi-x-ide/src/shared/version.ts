// ABOUTME: Exposes the Pi x IDE package version to runtime code.
// ABOUTME: Also the target version for VS Code-family extension auto-install; keep in step with upstream.

/**
 * Minimum upstream VS Code extension (`balaenis.pi-x-ide`) version auto-install aims for.
 * Upstream plugins are not republished from this repository, so this tracks the
 * latest upstream marketplace release, not this package's own version.
 */
export const PI_X_IDE_VERSION = "1.20.1";

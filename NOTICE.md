# Notice

## License

This collection is licensed **AGPL-3.0-only** (see [LICENSE](LICENSE)). Copyright © 2026 saifymatteo. Each package carries the same license in its own `LICENSE` file and manifest.

Upstream code keeps its own license and attribution; AGPL-3.0-only applies to the packages as distributed:

- `pi-codegraph` is a merge of the @izhimu/pi-codegraph 0.3.0 adapter (MIT, https://github.com/izhimu/pi-codegraph) with locally written automation. The upstream MIT portions remain MIT with their copyright notices retained in the source header.
- `pi-model-go` is ported from `@rizal72/oc-models-pro` (npm registry metadata reports MIT, version 0.3.1). Upstream attribution is retained in the source. The basis for this clearance is the registry's license field, not a line-by-line audit of the upstream distribution.

## Not bundled

`@saifymatteo/pi-orchestrator`, `@saifymatteo/pi-atelier`, `@saifymatteo/pi-agent-ask`, and `@saifymatteo/pi-x-ide` are not part of this collection. Credentials and personal endpoint/configuration values are not part of this repository.

## Before publishing

1. Publishes happen through GitHub Actions on tags using npm trusted publishing (OIDC): `<package>-v<version>` for one standalone package, `pi-extensions-v<version>` for the root collection; configure each package once on npmjs.com to trust this repository.
2. The root publishes as the all-in-one collection `@saifymatteo/pi-extensions`. Users should choose either the collection or individual packages, not both — they are different package identities and can duplicate commands and hooks.
3. If a future package vendors third-party code again, add its upstream license and attribution to this file and the package `NOTICE.md` before its first tag.

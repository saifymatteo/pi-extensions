# @saifymatteo/pi-vision

## Purpose and registrations

Registers a `context` hook, not a tool or slash command. Preserves native images for image-capable session models by default. For text-only/unknown models it replaces image blocks with model-generated descriptions. Optional `describe` / `describe-old` policies self-describe all/older images using the current model on OpenAI Chat Completions connections.

## Configuration and services

Reads `<agent-dir>/extensions/vision-toolkit.json`: `model`, optional `fallbacks`, `imagePolicy` (native/describe/describe-old), `lang` (en/zh), and `providers` overrides. Example points at example.invalid and must be reviewed manually; it is never loaded automatically. Provider override keys support `$ENV_NAME` references (not brace syntax).

Resolution also consults agent `models.json`, `models-store.json`, `auth.json`, and optional `haoyiyin/9router.json`. None of those real files are bundled. An explicit provider/model ID and override can resolve without a static catalog entry. Requires an image-capable OpenAI Chat Completions service; no CLI. Self-description requires current-model credentials in auth.json.

## Host limitations and security

The hook expects host-cloned request messages; rewriting should not mutate stored sessions. No config files are created. Missing/broken config leaves native-capable models native, but text-only models receive explicit failure markers rather than images. Image pixels and focus hints from surrounding user/assistant messages are transmitted to the model service; descriptions enter main-model context. Do not pass sensitive screenshots. Up to four concurrent requests, in-process cache, 180s per-request timeout and transient retries; configured HTTP failures can fail over. This is a lossy bridge, not an image security boundary.

Inherited caveats: cache keys include model ID but not provider/base URL; changing providers with the same ID can reuse cached descriptions until reload. The returned chain language is not propagated to individual candidates by the source. These behaviors were preserved, not repaired in this packaging work.

## Tests

From the monorepo root with its existing test dependencies available:

```sh
node --test packages/pi-vision/test/*.test.mjs
```

Tests use the shared test-only TypeScript/VM loader, fixtures, and host/service stubs. They do not prove compatibility with a live host, CLI, or model service.

## Running locally

From the monorepo root:

```sh
pi -e ./packages/pi-vision
```

Node >=24; host imports are peers, not bundled dependencies. Load only one copy: for an isolated session use `--no-extensions` with explicit `-e` paths so the original live extension is not also discovered. Set `PI_CODING_AGENT_DIR` to a disposable agent directory before launch; unset means the normal `~/.pi/agent` fallback. Extension config continues to resolve there, never relative to this package.

Examples are manually authored, sanitized reference documents, not runtime defaults. Review and manually create only the needed files in the isolated agent directory; do not copy live credentials or endpoints. No example is automatically loaded or copied. Loading an extension grants Pi-process OS permissions. This private package is UNLICENSED; publication requires clearance (NOTICE.md).

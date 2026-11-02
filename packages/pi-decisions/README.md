# @saifymatteo/pi-decisions

## Purpose and registrations

When configured, registers classifier providers and the `classify` tool (choice/bool/score; JSON state and optional PNG/JPEG/WebP images). No slash commands. Requires Pi's classifier model registry APIs (`findOfType`, `classify`, provider `classifiers`); older hosts may not implement them.

## Configuration and service

Reads `<agent-dir>/extensions/decisions.json` with a unique `models` allowlist and the shared `extensions/service-models.json` registry. Missing selector means no registration. Nothing is created automatically. Examples are inert; the example selector is empty, enabling no models. To opt in, manually review the registry example and set `models` to `["example-services/example-classifier"]` in your isolated selector. Registry models require `type: "classifier"`, `api: "openai-decisions"`, positive `contextWindow` and `input` capabilities.

Use an actual OpenAI Decisions-compatible service at your chosen base URL (POST `decisions` under the versioned base). Generic examples use localhost, not a configured personal server. API keys accept `$ENV` or `${ENV}`; if omitted, credentials fall back to agent `auth.json`. Prefer explicit environment references. No external CLI required.

## Security and limits

Supplied state, questions, and image pixels are transmitted to the selected model service. Never send secrets or treat confidence as a security decision. 30s timeout, no retries/provider fallback; at most four images, 10 MiB each/20 MiB total. Large results use private temp files. Service responses become model-visible. Source caveat: the classifier rejects an empty API key despite helper support for keyless access; use a nonempty configured key. The adapter also uses default fetch redirect behavior; use trusted endpoints.

## Tests

From the monorepo root with its existing test dependencies available:

```sh
node --test packages/pi-decisions/test/*.test.mjs
```

Tests use the shared test-only TypeScript/VM loader, fixtures, and host/service stubs. They do not prove compatibility with a live host, CLI, or model service.

## Running locally

From the monorepo root:

```sh
pi -e ./packages/pi-decisions
```

Node >=24; host imports are peers, not bundled dependencies. Load only one copy: for an isolated session use `--no-extensions` with explicit `-e` paths so the original live extension is not also discovered. Set `PI_CODING_AGENT_DIR` to a disposable agent directory before launch; unset means the normal `~/.pi/agent` fallback. Extension config continues to resolve there, never relative to this package.

Examples are manually authored, sanitized reference documents, not runtime defaults. Review and manually create only the needed files in the isolated agent directory; do not copy live credentials or endpoints. No example is automatically loaded or copied. Loading an extension grants Pi-process OS permissions. This private package is UNLICENSED; publication requires clearance (NOTICE.md).

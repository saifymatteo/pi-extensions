#!/usr/bin/env python3
"""Shared multi-provider vision client used by the proxy and glance CLI."""

from __future__ import annotations

import base64
from email.utils import parsedate_to_datetime
import http.client
import json
import mimetypes
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

DEFAULT_PROMPT = "Please describe the contents of this image in detail."
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)

LANG_INSTRUCTIONS = {
    "zh": "请使用简体中文回答。",
    "en": "Please respond in English.",
}


class VisionError(RuntimeError):
    """A safe, user-facing vision request failure."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status  # HTTP status code, when the failure was one


# Request-time failover state. PERMANENT_HTTP_STATUSES fail over immediately
# (unknown model, bad key); transient failures retry in place first, then
# fail over. _EXPLICIT_ENV marks a deliberately loaded env file, which the
# chain must never override.
PERMANENT_HTTP_STATUSES = {400, 401, 403, 404, 405, 422}
_EXPLICIT_ENV = False
_CHAIN_CACHE = None


def _resolution():
    global _CHAIN_CACHE
    if _CHAIN_CACHE is None:
        _CHAIN_CACHE = resolve_vision_config()
    return _CHAIN_CACHE


def load_env_file(path: str | os.PathLike[str] | None) -> None:
    if not path:
        return
    env_path = Path(path).expanduser()
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # The env file is the user's explicit configuration: whatever it sets wins,
        # even when the same variable already exists in the system environment.
        if key:
            os.environ[key] = value


# ---------------------------------------------------------------------------
# Configuration resolution
#
# extensions/vision-toolkit.json (under the Pi agent dir) drives everything:
#   {
#     "model": "9router/designer",     # "provider/model-id", or a bare "model-id"
#     "fallbacks": ["openrouter/google/gemini-2.5-flash-lite"],
#     "imagePolicy": "describe-old",   # native | describe | describe-old (proxy only)
#     "lang": "en",
#     "providers": {
#       "9router": {"baseUrl": "...", "apiKey": "...", "protocol": "chat_completions"}
#     }
#   }
#
# Per provider, sources are consulted in this order:
#   1. the user override in vision-toolkit.json providers.<name>
#   2. the model entry in models.json / models-store.json (baseUrl, api, input)
#      plus modelOverrides entries (capabilities for extension-registered models)
#   3. package-provider configs: pi packages register providers at runtime with
#      a live model catalog, so no static file lists their models; their
#      connection config lives in a package-owned file under the agent dir
#   4. auth.json credentials as written by Pi's /login (key or access)
#
# A candidate needs a baseUrl and an API key to resolve. A model id missing
# from every static catalog is fine when a runtime provider supplies the
# connection: the id is validated at request time by the API itself.

PACKAGE_PROVIDER_CONFIGS = {
    "9router": "haoyiyin/9router.json",
}

# models.json provider "api" types -> describe_image protocols
API_TYPE_TO_PROTOCOL = {
    "openai-completions": "chat_completions",
    "openai-responses": "responses",
    "anthropic-messages": "anthropic",
}


def _agent_dir() -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent")


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _expand_secret(value):
    """Allow "$ENV_NAME" references (as models.json does) in apiKey values."""
    if isinstance(value, str) and value.startswith("$") and len(value) > 1:
        return os.environ.get(value[1:], "")
    return value


def _load_toolkit_cfg(agent_dir: Path) -> dict:
    cfg = _read_json(agent_dir / "extensions" / "vision-toolkit.json")
    return cfg if isinstance(cfg, dict) else {}


def _candidate_specs(cfg: dict) -> list:
    """(provider, model_id) pairs: "model" first, then "fallbacks" in order.
    A bare id (no slash) has an empty provider and is searched for across
    every resolvable provider."""
    specs = []
    seen = set()
    raw = [cfg.get("model")] + list(cfg.get("fallbacks") or [])
    for spec in raw:
        if not isinstance(spec, str) or not spec.strip():
            continue
        spec = spec.strip()
        if "/" in spec:
            provider, _, model_id = spec.partition("/")
        else:
            provider, model_id = "", spec
        key = (provider, model_id)
        if model_id and key not in seen:
            seen.add(key)
            specs.append(key)
    return specs


def _snapshots(agent_dir: Path, cfg: dict) -> dict:
    models_json = _read_json(agent_dir / "models.json")
    models_store = _read_json(agent_dir / "models-store.json")
    auth = _read_json(agent_dir / "auth.json")
    pkgs = {}
    for name, rel in PACKAGE_PROVIDER_CONFIGS.items():
        data = _read_json(agent_dir / rel)
        if data:
            pkgs[name] = data
    providers_cfg = cfg.get("providers")
    user_providers = providers_cfg if isinstance(providers_cfg, dict) else {}
    return {"models": models_json, "store": models_store, "auth": auth,
            "pkgs": pkgs, "user": user_providers}


def _resolve_candidate(provider, model_id, agent_dir, snap):
    """Resolve one candidate to key/baseUrl/protocol/capability, or an error."""
    custom = (snap["models"].get("providers") or {}).get(provider) or {}
    store_models = (snap["store"].get(provider) or {}).get("models") or []
    entry = None
    for source in (custom.get("models") or [], store_models):
        match = next((m for m in source if isinstance(m, dict) and m.get("id") == model_id), None)
        if match:
            entry = match
            break
    overrides = (custom.get("modelOverrides") or {}).get(model_id) or {}
    cred = snap["auth"].get(provider) or {}
    pkg = snap["pkgs"].get(provider) or {}
    user_raw = snap["user"].get(provider)
    user = user_raw if isinstance(user_raw, dict) else {}

    base_url = (user.get("baseUrl") or (entry.get("baseUrl") if entry else None)
                or pkg.get("baseUrl") or custom.get("baseUrl"))
    key_value = (user.get("apiKey") or pkg.get("apiKey")
                 or custom.get("apiKey") or cred.get("key") or cred.get("access"))
    api_key = _expand_secret(key_value)
    key_source = None
    if user.get("apiKey"):
        key_source = "vision-toolkit.json providers.%s" % provider
    elif pkg.get("apiKey"):
        key_source = PACKAGE_PROVIDER_CONFIGS.get(provider, "package config")
    elif custom.get("apiKey"):
        key_source = "models.json providers.%s" % provider
    elif cred.get("key") or cred.get("access"):
        key_source = "auth.json (%s)" % ("key" if cred.get("key") else "access")
    base_source = None
    if user.get("baseUrl"):
        base_source = "vision-toolkit.json providers.%s" % provider
    elif entry is not None and entry.get("baseUrl"):
        base_source = "models.json model entry"
    elif pkg.get("baseUrl"):
        base_source = PACKAGE_PROVIDER_CONFIGS.get(provider, "package config")
    elif custom.get("baseUrl"):
        base_source = "models.json providers.%s" % provider

    protocol = user.get("protocol") or custom.get("protocol")
    if not protocol:
        protocol = API_TYPE_TO_PROTOCOL.get(custom.get("api"), "chat_completions")

    inputs = None
    for cap in (entry, overrides):
        if isinstance(cap, dict) and isinstance(cap.get("input"), list):
            inputs = cap["input"]
            break
    # None means unknown (runtime-registered catalog): validated at request time.
    image_capable = ("image" in inputs) if inputs else None

    if not base_url:
        return {"ok": False,
                "error": ('no baseUrl for provider "%s" (add providers.%s.baseUrl to '
                          'vision-toolkit.json, a models entry, or log the provider in)'
                          % (provider, provider))}
    if not api_key:
        return {"ok": False,
                "error": ('no API key for provider "%s" (run /login %s, or set '
                          'providers.%s.apiKey in vision-toolkit.json)'
                          % (provider, provider, provider))}
    return {"ok": True, "provider": provider, "model_id": model_id,
            "api_key": api_key, "base_url": str(base_url).rstrip("/"),
            "protocol": protocol, "image_capable": image_capable,
            "key_source": key_source, "base_source": base_source,
            "in_catalog": entry is not None}


def resolve_vision_config(agent_dir=None):
    """Resolve the candidate chain in vision-toolkit.json.

    Returns {"cfg": raw config dict, "agent_dir": Path, "attempts": [...],
    "config": first fully-resolved candidate dict or None}. attempts records
    every candidate with its outcome (api keys redacted)."""
    agent_dir = Path(agent_dir) if agent_dir else _agent_dir()
    cfg = _load_toolkit_cfg(agent_dir)
    snap = _snapshots(agent_dir, cfg)
    attempts = []
    resolved = []
    for provider, model_id in _candidate_specs(cfg):
        if provider:
            search = [provider]
        else:
            # Bare id: search every resolvable provider. Explicit catalog
            # entries first, then runtime-registered package providers,
            # which accept any model id.
            search = []
            for name, prov in (snap["models"].get("providers") or {}).items():
                if isinstance(prov, dict) and isinstance(prov.get("models"), list):
                    search.append(name)
            for name, prov in snap["store"].items():
                if isinstance(prov, dict) and (prov.get("models") or []):
                    if name not in search:
                        search.append(name)
            search.extend(n for n in PACKAGE_PROVIDER_CONFIGS if n not in search)
        spec = ("%s/%s" % (provider, model_id)) if provider else model_id
        for cand in search:
            result = _resolve_candidate(cand, model_id, agent_dir, snap)
            label = spec if len(search) == 1 else "%s (as %s/%s)" % (spec, cand, model_id)
            record = {k: v for k, v in result.items() if k != "api_key"}
            key = result.get("api_key") or ""
            record["key_fingerprint"] = (key[:6] + "..." + key[-4:]) if len(key) > 12 else ("***" if key else None)
            record["spec"] = label
            attempts.append(record)
            if result.get("ok"):
                # This spec is satisfied; the same bare id on other providers
                # is not a meaningful fallback, so move to the next spec.
                resolved.append(result)
                break
    return {"cfg": cfg, "agent_dir": agent_dir, "attempts": attempts,
            "resolved": resolved,
            "config": resolved[0] if resolved else None}


def apply_resolved_to_env(config):
    """Publish a resolved config into the VISION_* environment variables that
    describe_image and the CLIs read."""
    if not config or not config.get("ok"):
        return
    if config.get("api_key"):
        os.environ["VISION_API_KEY"] = config["api_key"]
    if config.get("base_url"):
        os.environ["VISION_BASE_URL"] = config["base_url"]
    os.environ["VISION_MODEL"] = config["model_id"]
    if config.get("protocol") and config["protocol"] != "chat_completions":
        os.environ["VISION_API_PROTOCOL"] = config["protocol"]


def load_pi_vision_json():
    """Resolve vision-toolkit.json and publish the first resolvable candidate
    into the environment. Wins over the legacy env chain; when nothing
    resolves, existing env values are left untouched."""
    resolution = resolve_vision_config()
    apply_resolved_to_env(resolution["config"])
    lang = resolution["cfg"].get("lang")
    if lang:
        os.environ["LANG"] = lang
def load_default_env() -> None:
    explicit = os.environ.get("VISION_ENV_FILE")
    if explicit:
        # An explicitly pointed env file is the user's deliberate override:
        # it short-circuits everything else, including vision-toolkit.json
        # and the failover chain.
        global _EXPLICIT_ENV
        _EXPLICIT_ENV = True
        load_env_file(Path(explicit).expanduser())
        return
    candidates = []
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidates.append(Path(local_appdata) / "agent-vision-toolkit" / "env")
    candidates.extend([
        Path.home() / ".config" / "agent-vision-toolkit" / "env",
        Path(__file__).resolve().parent / ".env",
        Path.cwd() / ".env",
    ])
    pi_coding_agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    if pi_coding_agent_dir:
        candidates.append(Path(pi_coding_agent_dir) / ".env")
    for path in candidates:
        load_env_file(path)
    load_pi_vision_json()


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise VisionError(
            f"Missing config {name}; run 'vision-doctor' to inspect the "
            "vision-toolkit.json chain (model, fallbacks, providers), or set the "
            "legacy .env values"
        )
    return value


def validate_vision_config() -> None:
    for name in ("VISION_API_KEY", "VISION_BASE_URL", "VISION_MODEL"):
        _required(name)


def image_path_to_data_url(path: str | os.PathLike[str]) -> str:
    image_path = Path(path).expanduser()
    if not image_path.is_file():
        raise VisionError(f"Image not found: {image_path}")
    mime, _ = mimetypes.guess_type(image_path.name)
    if mime not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
        raise VisionError("Only PNG, JPEG, GIF, and WebP images are supported")
    return f"data:{mime};base64,{base64.b64encode(image_path.read_bytes()).decode()}"


def _message_text(message: object) -> str:
    if isinstance(message, str):
        return message.strip()
    if isinstance(message, list):
        return "\n".join(
            part["text"] for part in message
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ).strip()
    return ""


def _responses_text(response: object) -> str:
    if not isinstance(response, dict) or not isinstance(response.get("output"), list):
        return ""
    return "\n".join(
        part["text"]
        for item in response["output"]
        if isinstance(item, dict) and item.get("type") == "message"
        and isinstance(item.get("content"), list)
        for part in item["content"]
        if isinstance(part, dict) and part.get("type") == "output_text"
        and isinstance(part.get("text"), str)
    ).strip()


def _anthropic_image_source(url: str) -> dict[str, str]:
    if not url.startswith("data:"):
        return {"type": "url", "url": url}
    header, separator, data = url.partition(",")
    if separator == "" or ";base64" not in header:
        raise VisionError("Anthropic image data URLs must use base64 encoding")
    media_type = header[5:].split(";", 1)[0]
    if not media_type:
        raise VisionError("Anthropic image data URLs must include a media type")
    return {"type": "base64", "media_type": media_type, "data": data}


def _anthropic_text(response: object) -> str:
    if not isinstance(response, dict) or not isinstance(response.get("content"), list):
        return ""
    return "\n".join(
        block["text"]
        for block in response["content"]
        if isinstance(block, dict) and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ).strip()


def _redact(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "<redacted>")
    return text


def _retry_delay(error: urllib.error.HTTPError, attempt: int) -> float:
    value = error.headers.get("Retry-After")
    if value:
        try:
            return max(0.0, min(float(value), 60.0))
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(value)
                return max(0.0, min(retry_at.timestamp() - time.time(), 60.0))
            except (TypeError, ValueError, OverflowError):
                pass
    return min(2 ** attempt, 4)


def _describe_attempt(image_url: str | list[str], prompt: str | None = None,
                      max_tokens: int = 4096, apply_lang: bool = True) -> str:
    """One candidate attempt: reads the VISION_* env, retries transient
    failures in place, raises VisionError (with .status for HTTP errors)."""
    validate_vision_config()
    urls = [image_url] if isinstance(image_url, str) else list(image_url)
    if not urls:
        raise VisionError("No image was provided")
    for url in urls:
        if not url.startswith(("data:", "http://", "https://")):
            raise VisionError("Only data URLs or http(s) image URLs are supported")
    base_url = _required("VISION_BASE_URL").rstrip("/")
    api_key = _required("VISION_API_KEY")
    user_agent = os.environ.get("VISION_USER_AGENT", "").strip() or DEFAULT_USER_AGENT
    text = prompt or DEFAULT_PROMPT
    if apply_lang:
        instruction = LANG_INSTRUCTIONS.get(os.environ.get("LANG", "").strip().lower())
        if instruction:
            text = f"{instruction}\n\n{text}"
    model = _required("VISION_MODEL")
    protocol = os.environ.get("VISION_API_PROTOCOL", "").strip().lower() or "chat_completions"
    if protocol == "responses":
        payload = {
            "model": model,
            "store": False,
            "input": [{"role": "user", "content": [
                {"type": "input_image", "image_url": url} for url in urls
            ] + [{"type": "input_text", "text": text}]}],
        }
        if max_tokens is not None:
            payload["max_output_tokens"] = max_tokens
        reasoning_effort = os.environ.get("VISION_REASONING_EFFORT", "").strip()
        if reasoning_effort:
            payload["reasoning"] = {"effort": reasoning_effort}
        endpoint = "/responses"
        extract_text = _responses_text
    elif protocol == "chat_completions":
        payload = {
            "model": model,
            "stream": False,
            "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": url}} for url in urls
            ] + [{"type": "text", "text": text}]}],
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        endpoint = "/chat/completions"
        extract_text = lambda data: _message_text(data["choices"][0]["message"]["content"])
    elif protocol == "anthropic":
        payload = {
            "model": model,
            "max_tokens": max_tokens if max_tokens is not None else 4096,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": _anthropic_image_source(url)} for url in urls
            ] + [{"type": "text", "text": text}]}],
        }
        thinking = os.environ.get("VISION_ANTHROPIC_THINKING", "").strip().lower() or "omit"
        if thinking != "omit":
            if thinking not in {"disabled", "adaptive"}:
                raise VisionError(
                    "Unsupported VISION_ANTHROPIC_THINKING; use omit, disabled, or adaptive"
                )
            payload["thinking"] = {"type": thinking}
        endpoint = "/messages"
        extract_text = _anthropic_text
    else:
        raise VisionError(
            "Unsupported VISION_API_PROTOCOL; use chat_completions, responses, or anthropic"
        )
    headers = {
        "Content-Type": "application/json",
        "User-Agent": user_agent,
    }
    if protocol == "anthropic":
        headers.update({
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        })
    else:
        headers["Authorization"] = "Bearer " + api_key
    request = urllib.request.Request(base_url + endpoint, data=json.dumps(payload).encode(), headers=headers)
    retries = 2
    timeout = 180
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.load(response)
            try:
                text = extract_text(data)
            except (KeyError, IndexError, TypeError) as exc:
                raise VisionError("Vision API returned an incompatible response structure") from exc
            if not text:
                raise VisionError("Vision API returned an empty description")
            return text
        except urllib.error.HTTPError as exc:
            body = _redact(exc.read().decode(errors="replace")[:400], api_key)
            body = body.replace("\r", " ").replace("\n", " ")
            if exc.code in {429, 500, 502, 503, 504, 529} and attempt < retries:
                print(f"vision: HTTP {exc.code}, retrying ({attempt + 1}/{retries})", file=sys.stderr)
                time.sleep(_retry_delay(exc, attempt))
                continue
            raise VisionError(f"Vision API HTTP {exc.code}: {body}", status=exc.code) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as exc:
            if attempt < retries:
                print(f"vision: {type(exc).__name__}, retrying ({attempt + 1}/{retries})", file=sys.stderr)
                time.sleep(min(2 ** attempt, 4))
                continue
            reason = _redact(str(getattr(exc, "reason", str(exc))), api_key)
            raise VisionError(f"Vision API network error: {reason}") from exc
        except json.JSONDecodeError as exc:
            raise VisionError("Vision API returned invalid JSON") from exc
    raise VisionError("Vision API request failed")


def describe_image(image_url: str | list[str], prompt: str | None = None,
                   max_tokens: int = 4096, apply_lang: bool = True,
                   config: dict | None = None) -> str:
    """Describe one data/http image URL (str) or several (list) in a single
    call. Walks the candidate chain from vision-toolkit.json: transient
    failures retry in place, then fail over to the next candidate; permanent
    failures (bad key, unknown model) fail over immediately. Pass
    config=<one resolved candidate> to pin exactly that candidate
    (vision-doctor --smoke does)."""
    if config is not None:
        candidates = [config]
    elif _EXPLICIT_ENV:
        candidates = [None]  # the user's env file is the deliberate override
    else:
        candidates = _resolution()["resolved"] or [None]
    last_error = None
    for index, candidate in enumerate(candidates):
        if candidate is not None and candidate.get("ok"):
            apply_resolved_to_env(candidate)
        try:
            return _describe_attempt(image_url, prompt, max_tokens, apply_lang)
        except VisionError as exc:
            last_error = exc
            permanent = exc.status in PERMANENT_HTTP_STATUSES
            transient_exhausted = exc.status is not None
            if index + 1 < len(candidates) and (permanent or transient_exhausted):
                nxt = candidates[index + 1]
                nxt_label = (nxt or {}).get("model_id") or "environment"
                cur_label = (candidate or {}).get("model_id") or "environment"
                print(f"vision: {cur_label} failed ({exc}); failing over to {nxt_label}",
                      file=sys.stderr)
                continue
            raise
    raise last_error  # pragma: no cover - the loop always returns or raises

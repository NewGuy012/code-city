"""Provider-ordered LLM summarizer: local llama.cpp first -> Gemini fallback -> AST fallback."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from codecity.analyzer.semantic import RepoDocsContext
from codecity.models import BuildingDescription, CityBriefing, DistrictGuide
from codecity.storage.llm_cache import LlmSummaryCache, hash_text, make_cache_key

DEFAULT_LLAMACPP_URL = "http://127.0.0.1:8080"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
_PROBE_TTL_SECONDS = 20.0
_MAX_SOURCE_CHARS = 4500
_SENSITIVE_NAME_RE = re.compile(
    r"(?:^\.env(?:\.|$)|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|secret|credential|password)",
    re.I,
)

_PROBE_LOCK = threading.Lock()
_PROBE_CACHE: dict[str, tuple[float, bool, str | None]] = {}


def reset_probe_cache() -> None:
    """Reset cached llama.cpp health probe state (useful in tests)."""
    with _PROBE_LOCK:
        _PROBE_CACHE.clear()


def _cap(text: str, limit: int) -> str:
    cleaned = " ".join(str(text or "").split()).strip()
    if len(cleaned) <= limit:
        return cleaned
    cut = cleaned[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}..." if cut else cleaned[:limit]


def _extract_json_object(raw_text: str) -> dict[str, Any] | None:
    """Parse JSON object from model output, tolerating fenced markdown blocks."""
    txt = raw_text.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    try:
        parsed = json.loads(txt)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    start = txt.find("{")
    end = txt.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(txt[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None
    return None


def _is_sensitive_file(file_path: str) -> bool:
    name = Path(file_path).name
    return bool(_SENSITIVE_NAME_RE.search(name))


def _env_provider_mode() -> str:
    raw = os.environ.get("CODECITY_LLM_PROVIDER", "auto").strip().lower()
    if raw in {"auto", "llamacpp", "gemini", "off"}:
        return raw
    return "auto"


def _llamacpp_url() -> str:
    raw = os.environ.get("CODECITY_LLAMACPP_URL", DEFAULT_LLAMACPP_URL).strip().rstrip("/")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return DEFAULT_LLAMACPP_URL
    return raw


def _gemini_api_key() -> str | None:
    for key_name in ("CODECITY_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        val = os.environ.get(key_name, "").strip()
        if val:
            return val
    return None


def _gemini_model() -> str:
    return (
        os.environ.get("CODECITY_GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
        or DEFAULT_GEMINI_MODEL
    )


def _llamacpp_timeout() -> float:
    try:
        return max(2.0, float(os.environ.get("CODECITY_LLAMACPP_TIMEOUT", "25")))
    except ValueError:
        return 25.0


def _gemini_timeout() -> float:
    try:
        return max(2.0, float(os.environ.get("CODECITY_GEMINI_TIMEOUT", "20")))
    except ValueError:
        return 20.0


def _http_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
) -> tuple[int, dict[str, Any] | None]:
    req_headers = {"Accept": "application/json", **(headers or {})}
    body_bytes: bytes | None = None
    if payload is not None:
        req_headers["Content-Type"] = "application/json"
        body_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body_bytes, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            return exc.code, json.loads(raw) if raw.strip() else None
        except Exception:
            return exc.code, None
    except Exception:
        return 0, None


def probe_llamacpp(*, force: bool = False) -> tuple[bool, str | None]:
    """Check if local `llama.cpp` `llama-server` is reachable and discover its active model."""
    base_url = _llamacpp_url()
    now = time.monotonic()
    if not force:
        with _PROBE_LOCK:
            cached = _PROBE_CACHE.get(base_url)
            if cached and (now - cached[0]) < _PROBE_TTL_SECONDS:
                return cached[1], cached[2]

    override_model = os.environ.get("CODECITY_LLAMACPP_MODEL", "").strip() or None
    health_status, health_data = _http_json(f"{base_url}/health", timeout=0.8)
    ready = health_status == 200 and (
        not isinstance(health_data, dict)
        or health_data.get("status", "ok") in {"ok", "ready", "healthy"}
    )

    discovered_model = override_model
    if ready or health_status == 404:
        # Some OpenAI-compatible llama.cpp / proxy servers only expose `/v1/models`
        models_status, models_data = _http_json(f"{base_url}/v1/models", timeout=0.8)
        if models_status == 200 and isinstance(models_data, dict):
            ready = True
            if not discovered_model:
                data_list = models_data.get("data")
                if isinstance(data_list, list) and data_list:
                    first = data_list[0]
                    if isinstance(first, dict) and first.get("id"):
                        discovered_model = str(first["id"])

    if ready and not discovered_model:
        discovered_model = "local-llamacpp"

    with _PROBE_LOCK:
        _PROBE_CACHE[base_url] = (now, ready, discovered_model if ready else None)
    return ready, (discovered_model if ready else None)


def describe_llm_status() -> dict[str, Any]:
    """Return non-secret LLM runtime status (`llama.cpp` first, `gemini` fallback)."""
    mode = _env_provider_mode()
    if mode == "off":
        return {
            "llm_enabled": False,
            "llm_provider": None,
            "llm_model": None,
            "llm_fallback_provider": None,
        }

    llama_ready, llama_model = (False, None)
    if mode in {"auto", "llamacpp"}:
        llama_ready, llama_model = probe_llamacpp()

    has_gemini = mode in {"auto", "gemini"} and bool(_gemini_api_key())
    gemini_model = _gemini_model() if has_gemini else None

    if llama_ready:
        return {
            "llm_enabled": True,
            "llm_provider": "llamacpp",
            "llm_model": llama_model,
            "llm_fallback_provider": "gemini" if has_gemini else None,
        }
    if has_gemini:
        return {
            "llm_enabled": True,
            "llm_provider": "gemini",
            "llm_model": gemini_model,
            "llm_fallback_provider": None,
        }
    return {
        "llm_enabled": False,
        "llm_provider": None,
        "llm_model": None,
        "llm_fallback_provider": None,
    }


def _call_llamacpp_json(
    system_prompt: str,
    user_prompt: str,
    model_name: str,
) -> dict[str, Any] | None:
    base_url = _llamacpp_url()
    timeout = _llamacpp_timeout()
    base_payload: dict[str, Any] = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 520,
    }
    status, data = _http_json(
        f"{base_url}/v1/chat/completions",
        method="POST",
        payload={**base_payload, "response_format": {"type": "json_object"}},
        timeout=timeout,
    )
    if status == 400:
        # Retry once without `response_format` if older llama-server rejects it
        status, data = _http_json(
            f"{base_url}/v1/chat/completions",
            method="POST",
            payload=base_payload,
            timeout=timeout,
        )
    if status != 200 or not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    msg = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = msg.get("content") if isinstance(msg, dict) else None
    return _extract_json_object(str(content)) if content else None


def _call_gemini_json(
    system_prompt: str,
    user_prompt: str,
    *,
    api_key: str,
    model_name: str,
) -> dict[str, Any] | None:
    safe_model = urllib.parse.quote(model_name, safe=".-_")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{safe_model}:generateContent"
    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 560,
            "responseMimeType": "application/json",
        },
    }
    status, data = _http_json(
        url,
        method="POST",
        payload=payload,
        headers={"x-goog-api-key": api_key},
        timeout=_gemini_timeout(),
    )
    if status != 200 or not isinstance(data, dict):
        return None
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        return None
    text = parts[0].get("text") if isinstance(parts[0], dict) else None
    return _extract_json_object(str(text)) if text else None


def _invoke_ordered_llm(
    system_prompt: str,
    user_prompt: str,
    *,
    allow_cloud: bool = True,
) -> tuple[str, str, dict[str, Any]] | None:
    """Try local `llama.cpp` first, then fall back to Gemini if configured & allowed."""
    mode = _env_provider_mode()
    if mode == "off":
        return None

    if mode in {"auto", "llamacpp"}:
        ready, model_name = probe_llamacpp()
        if ready and model_name:
            res = _call_llamacpp_json(system_prompt, user_prompt, model_name)
            if res is not None:
                return ("llamacpp", model_name, res)

    if allow_cloud and mode in {"auto", "gemini"}:
        api_key = _gemini_api_key()
        if api_key:
            model_name = _gemini_model()
            res = _call_gemini_json(
                system_prompt,
                user_prompt,
                api_key=api_key,
                model_name=model_name,
            )
            if res is not None:
                return ("gemini", model_name, res)

    return None


def _provider_candidates(*, allow_cloud: bool) -> list[tuple[str, str]]:
    mode = _env_provider_mode()
    if mode == "off":
        return []
    out: list[tuple[str, str]] = []
    if mode in {"auto", "llamacpp"}:
        ready, mname = probe_llamacpp()
        if ready and mname:
            out.append(("llamacpp", mname))
    if allow_cloud and mode in {"auto", "gemini"} and _gemini_api_key():
        out.append(("gemini", _gemini_model()))
    return out


def enhance_city_briefing_with_llm(
    briefing: CityBriefing,
    docs_ctx: RepoDocsContext,
    *,
    repo_slug: str,
    cache: LlmSummaryCache | None = None,
) -> CityBriefing:
    """Enhance `CityBriefing` with plain-English prose using llama.cpp first, then Gemini."""
    if _env_provider_mode() == "off":
        return briefing

    briefing_digest_src = json.dumps(
        {
            "repo": briefing.repo_name,
            "readme": docs_ctx.readme_excerpt[:1400],
            "districts": [
                {"path": d.district_path, "label": d.plain_label, "files": d.file_count}
                for d in briefing.district_guides
            ],
            "starts": [s.file_path for s in briefing.recommended_starts],
        },
        sort_keys=True,
    )
    content_hash = hash_text(briefing_digest_src)
    context_hash = hash_text(docs_ctx.overview[:300])

    candidates = _provider_candidates(allow_cloud=True)
    if cache is not None:
        for prov, model in candidates:
            ck = make_cache_key(
                kind="briefing",
                provider=prov,
                model=model,
                content_hash=content_hash,
                context_hash=context_hash,
            )
            hit = cache.get(ck)
            if hit is not None:
                return _apply_briefing_llm_payload(briefing, hit[0], hit[1], hit[2])

    system_prompt = (
        "You are the friendly Mayor of CodeCity onboarding a brand-new, possibly non-technical "
        "teammate (such as a designer, PM, or new engineer) onto a software repository. "
        "Explain clearly in plain, jargon-free English. Return strictly valid JSON only."
    )
    user_payload = {
        "repository": briefing.repo_name,
        "readme_excerpt": docs_ctx.readme_excerpt[:1400],
        "baseline_overview": briefing.overview,
        "districts": [
            {
                "district_path": d.district_path,
                "category": d.plain_label,
                "file_count": d.file_count,
                "current_summary": d.summary,
            }
            for d in briefing.district_guides
        ],
        "recommended_files": [
            {"file_path": s.file_path, "role": s.title, "reason": s.reason}
            for s in briefing.recommended_starts
        ],
        "required_json_schema": {
            "mayor_welcome": "Warm 2-3 sentence welcome from the Mayor (<= 340 chars)",
            "overview": (
                "2-4 plain-English sentences explaining what the software does "
                "and who it helps (<= 500 chars)"
            ),
            "architecture_summary": (
                "2-3 plain-English sentences explaining how the main neighborhoods "
                "fit together (<= 380 chars)"
            ),
            "district_summaries": (
                "Object mapping each district_path to 1 plain-English sentence (<= 160 chars)"
            ),
        },
    }
    result = _invoke_ordered_llm(system_prompt, json.dumps(user_payload), allow_cloud=True)
    if result is None:
        if cache is not None:
            any_hit = cache.get_any_for_content("briefing", content_hash, context_hash)
            if any_hit is not None:
                return _apply_briefing_llm_payload(briefing, any_hit[0], any_hit[1], any_hit[2])
        return briefing

    prov, model, llm_json = result
    if cache is not None:
        ck = make_cache_key(
            kind="briefing",
            provider=prov,
            model=model,
            content_hash=content_hash,
            context_hash=context_hash,
        )
        cache.put(
            ck,
            kind="briefing",
            provider=prov,
            model=model,
            content_hash=content_hash,
            context_hash=context_hash,
            repo_slug=repo_slug,
            target_key="__briefing__",
            payload=llm_json,
        )
    return _apply_briefing_llm_payload(briefing, prov, model, llm_json)


def _apply_briefing_llm_payload(
    briefing: CityBriefing,
    provider: str,
    model: str,
    payload: dict[str, Any],
) -> CityBriefing:
    welcome = _cap(str(payload.get("mayor_welcome") or ""), 360)
    overview = _cap(str(payload.get("overview") or ""), 540)
    arch = _cap(str(payload.get("architecture_summary") or ""), 400)
    raw_dist_map = payload.get("district_summaries")
    dist_map = raw_dist_map if isinstance(raw_dist_map, dict) else {}

    updated_guides: list[DistrictGuide] = []
    for g in briefing.district_guides:
        custom = dist_map.get(g.district_path)
        if isinstance(custom, str) and len(custom.strip()) >= 12:
            updated_guides.append(g.model_copy(update={"summary": _cap(custom, 180)}))
        else:
            updated_guides.append(g)

    return briefing.model_copy(
        update={
            "mayor_welcome": welcome if len(welcome) >= 20 else briefing.mayor_welcome,
            "overview": overview if len(overview) >= 20 else briefing.overview,
            "architecture_summary": arch if len(arch) >= 15 else briefing.architecture_summary,
            "district_guides": updated_guides,
            "source": provider,
            "model": model,
        }
    )


def enhance_building_description_with_llm(
    desc: BuildingDescription,
    *,
    file_path: str,
    source_text: str,
    repo_name: str,
    docs_ctx: RepoDocsContext | None = None,
    repo_slug: str = "",
    cache: LlmSummaryCache | None = None,
) -> BuildingDescription:
    """Enhance a `BuildingDescription` via local `llama.cpp` first, then Gemini/AST fallback."""
    if _env_provider_mode() == "off":
        return desc

    sensitive = _is_sensitive_file(file_path)
    allow_cloud = not sensitive
    content_hash = hash_text(source_text[:12000])
    readme_ctx_txt = (docs_ctx.overview[:300] if docs_ctx else "") + (desc.readme_context or "")
    context_hash = hash_text(readme_ctx_txt)

    candidates = _provider_candidates(allow_cloud=allow_cloud)
    if cache is not None:
        for prov, model in candidates:
            ck = make_cache_key(
                kind="file",
                provider=prov,
                model=model,
                content_hash=content_hash,
                context_hash=context_hash,
            )
            hit = cache.get(ck)
            if hit is not None:
                return _apply_file_llm_payload(desc, hit[0], hit[1], hit[2])

    system_prompt = (
        "You explain individual code files to teammates (including non-technical teammates) "
        "trying to understand a codebase quickly. Be concrete, accurate to the provided code "
        "and AST facts, and avoid filler. Return strictly valid JSON only."
    )
    excerpt = "" if sensitive else source_text[:_MAX_SOURCE_CHARS]
    user_payload = {
        "repository": repo_name,
        "repo_overview": docs_ctx.overview[:350] if docs_ctx else "",
        "file_path": file_path,
        "readme_mention": desc.readme_context or "",
        "ast_summary": desc.short_summary,
        "symbols": [{"name": s.name, "kind": s.kind, "doc": s.doc} for s in desc.key_symbols[:8]],
        "endpoints": desc.endpoints[:8],
        "external_packages": desc.external_packages[:8],
        "code_excerpt": excerpt,
        "required_json_schema": {
            "short_summary": (
                "1-2 clear plain-English sentences saying what this file does (<= 220 chars)"
            ),
            "detailed_overview": (
                "3-4 readable sentences explaining how it works and fits with "
                "neighboring files (<= 580 chars)"
            ),
            "responsibilities": (
                "Array of 2-5 concise plain-English bullet strings (each <= 110 chars)"
            ),
        },
    }
    result = _invoke_ordered_llm(system_prompt, json.dumps(user_payload), allow_cloud=allow_cloud)
    if result is None:
        if cache is not None:
            any_hit = cache.get_any_for_content(
                "file",
                content_hash,
                context_hash,
                preferred_providers=("llamacpp", "gemini") if allow_cloud else ("llamacpp",),
            )
            if any_hit is not None:
                return _apply_file_llm_payload(desc, any_hit[0], any_hit[1], any_hit[2])
        return desc

    prov, model, llm_json = result
    if cache is not None:
        ck = make_cache_key(
            kind="file",
            provider=prov,
            model=model,
            content_hash=content_hash,
            context_hash=context_hash,
        )
        cache.put(
            ck,
            kind="file",
            provider=prov,
            model=model,
            content_hash=content_hash,
            context_hash=context_hash,
            repo_slug=repo_slug,
            target_key=file_path,
            payload=llm_json,
        )
    return _apply_file_llm_payload(desc, prov, model, llm_json)


def _apply_file_llm_payload(
    desc: BuildingDescription,
    provider: str,
    model: str,
    payload: dict[str, Any],
) -> BuildingDescription:
    short = _cap(str(payload.get("short_summary") or ""), 235)
    detailed = _cap(str(payload.get("detailed_overview") or ""), 620)
    raw_resps = payload.get("responsibilities")
    resps: list[str] = []
    if isinstance(raw_resps, list):
        for item in raw_resps[:6]:
            cleaned = _cap(str(item), 120)
            if cleaned:
                resps.append(cleaned)

    return desc.model_copy(
        update={
            "short_summary": short if len(short) >= 16 else desc.short_summary,
            "detailed_overview": detailed if len(detailed) >= 24 else desc.detailed_overview,
            "responsibilities": resps if resps else desc.responsibilities,
            "source": provider,
            "model": model,
        }
    )

"""SQLite WAL content-addressed cache for LLM-generated briefings and building summaries."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PROMPT_VERSION = "v1"


def hash_text(text: str) -> str:
    """Return a short SHA-256 digest for content-addressed cache keys."""
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24]


def make_cache_key(
    *,
    kind: str,
    provider: str,
    model: str,
    content_hash: str,
    context_hash: str = "",
    prompt_version: str = PROMPT_VERSION,
) -> str:
    """Build deterministic cache key scoped to content, context, provider, and prompt."""
    raw = f"{kind}|{provider}|{model}|{prompt_version}|{content_hash}|{context_hash}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class LlmSummaryCache:
    """Thread-safe local SQLite cache storing LLM descriptions across analyses and clicks."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.db_path), timeout=5.0)
        con.execute("PRAGMA journal_mode=WAL;")
        con.execute("PRAGMA synchronous=NORMAL;")
        return con

    def _init_schema(self) -> None:
        with self._lock, self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_summaries (
                    cache_key TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    context_hash TEXT NOT NULL,
                    repo_slug TEXT NOT NULL,
                    target_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            con.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_llm_content
                ON llm_summaries (kind, content_hash, context_hash);
                """
            )

    def get(self, cache_key: str) -> tuple[str, str, dict[str, Any]] | None:
        """Fetch `(provider, model, payload)` by exact `cache_key`."""
        with self._lock, self._connect() as con:
            row = con.execute(
                "SELECT provider, model, payload_json FROM llm_summaries "
                "WHERE cache_key = ? LIMIT 1;",
                (cache_key,),
            ).fetchone()
        if not row:
            return None
        try:
            payload = json.loads(row[2])
        except Exception:
            return None
        return (str(row[0]), str(row[1]), payload) if isinstance(payload, dict) else None

    def get_any_for_content(
        self,
        kind: str,
        content_hash: str,
        context_hash: str = "",
        *,
        preferred_providers: tuple[str, ...] = ("llamacpp", "gemini"),
    ) -> tuple[str, str, dict[str, Any]] | None:
        """Fetch cached LLM output for matching content across providers, honoring preference."""
        with self._lock, self._connect() as con:
            rows = con.execute(
                """
                SELECT provider, model, payload_json
                FROM llm_summaries
                WHERE kind = ? AND content_hash = ? AND context_hash = ?
                ORDER BY updated_at DESC;
                """,
                (kind, content_hash, context_hash),
            ).fetchall()
        if not rows:
            return None

        rank = {prov: idx for idx, prov in enumerate(preferred_providers)}
        rows_sorted = sorted(rows, key=lambda r: rank.get(str(r[0]), len(preferred_providers)))
        for prov, model, raw_json in rows_sorted:
            try:
                payload = json.loads(raw_json)
            except Exception:
                continue
            if isinstance(payload, dict):
                return str(prov), str(model), payload
        return None

    def put(
        self,
        cache_key: str,
        *,
        kind: str,
        provider: str,
        model: str,
        content_hash: str,
        context_hash: str,
        repo_slug: str,
        target_key: str,
        payload: dict[str, Any],
    ) -> None:
        """Persist an LLM response under `cache_key`."""
        now = datetime.now(UTC).isoformat()
        raw = json.dumps(payload, ensure_ascii=False)
        with self._lock, self._connect() as con:
            con.execute(
                """
                INSERT INTO llm_summaries (
                    cache_key, kind, provider, model, content_hash, context_hash,
                    repo_slug, target_key, payload_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    provider = excluded.provider,
                    model = excluded.model,
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at;
                """,
                (
                    cache_key,
                    kind,
                    provider,
                    model,
                    content_hash,
                    context_hash,
                    repo_slug,
                    target_key,
                    raw,
                    now,
                ),
            )

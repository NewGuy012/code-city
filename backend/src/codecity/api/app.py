"""FastAPI Control Plane: SSE ingestion, Quack CORS proxy, Parquet export, and Live Mayor."""

from __future__ import annotations

import asyncio
import http.client
import json
import re
import tempfile
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import duckdb
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from codecity.analyzer.briefing import build_city_briefing
from codecity.analyzer.describer import build_file_description
from codecity.analyzer.git_history import resolve_git_repo, run_git
from codecity.analyzer.llm_summarizer import (
    describe_llm_status,
    enhance_building_description_with_llm,
    enhance_city_briefing_with_llm,
)
from codecity.analyzer.pipeline import analyze_repository
from codecity.analyzer.plugins import preview_file_fix
from codecity.analyzer.plugins.base import safe_repo_target
from codecity.analyzer.role_classifier import classify_building_archetype
from codecity.analyzer.semantic import extract_repo_docs_context, match_doc_for_file
from codecity.analyzer.treesitter_core import (
    MAX_ANALYZED_FILE_BYTES,
    analyze_file_ast,
    detect_language,
)
from codecity.api.exporter import (
    default_frontend_dist,
    export_static_site,
    render_grade_badge_svg,
)
from codecity.api.mayor import (
    ensure_mayor_branch,
    execute_live_mayor_tool,
    list_repo_authors_90d,
)
from codecity.models import (
    AnalyzeRequest,
    Annotation,
    BuildingArchetype,
    BuildingDescription,
    CityBriefing,
    District,
    ExternalDep,
    FileImport,
    FileMetric,
    FixDiffResult,
    SandboxAction,
    ZoneType,
)
from codecity.storage.lakehouse import (
    EXPORT_TABLES,
    LakehouseManager,
    infer_owner_repo,
    sanitize_identifier,
    validate_action_id,
)
from codecity.storage.llm_cache import LlmSummaryCache
from codecity.storage.quack_server import QuackServerManager

_LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
_LOCAL_HOST_RE = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\]|testserver)(:\d+)?$", re.I)
_COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
_MUTATING_METHODS = frozenset({"POST", "PUT", "DELETE", "PATCH"})
_MAX_QUACK_BODY_BYTES = 16 * 1024 * 1024
_INLINE_CODE_MAX_LINES = 500
_HOP_BY_HOP_REQ_HEADERS = frozenset(
    {"host", "content-length", "connection", "transfer-encoding", "keep-alive", "cookie"}
)
_HOP_BY_HOP_RESP_HEADERS = frozenset(
    {"content-length", "transfer-encoding", "connection", "keep-alive"}
)
_MAX_JOBS_RETAINED = 64


class AnnotationCreateRequest(BaseModel):
    file_path: str = Field(min_length=1, max_length=512)
    author: str = Field(default="mayor", max_length=80)
    tag: str = Field(default="note", max_length=40)
    body: str = Field(min_length=1, max_length=4000)


class FixDiffRequest(BaseModel):
    file_path: str = Field(min_length=1, max_length=512)


class ExportRequest(BaseModel):
    with_postcard: bool = True


class MayorExecuteRequest(BaseModel):
    tool: str = Field(min_length=1, max_length=40)
    target_path: str = Field(min_length=1, max_length=512)
    secondary_path: str | None = Field(default=None, max_length=512)
    district_path: str = Field(default="", max_length=512)
    confirm: bool = False


class SandboxActionCreateRequest(BaseModel):
    action_id: str | None = Field(default=None, max_length=64)
    session_id: str = Field(default="default", max_length=64)
    author: str = Field(default="mayor", max_length=80)
    tool: str = Field(min_length=1, max_length=40)
    target_path: str = Field(min_length=1, max_length=512)
    secondary_path: str | None = Field(default=None, max_length=512)
    district_path: str = Field(default="", max_length=512)
    summary: str = Field(min_length=1, max_length=500)
    velocity_cost: int = Field(default=0, ge=0, le=10000)


class SandboxToggleRequest(BaseModel):
    active: bool


@dataclass
class AnalyzeJob:
    job_id: str
    owner: str
    repo: str
    status: str = "queued"
    events: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


def _proxy_local_http(
    host: str,
    port: int,
    method: str,
    path: str,
    headers: dict[str, str],
    body: bytes,
) -> tuple[int, list[tuple[str, str]], bytes]:
    conn = http.client.HTTPConnection(host, port, timeout=30.0)
    try:
        conn.request(method, path, body=body or None, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.getheaders(), resp.read()
    finally:
        conn.close()


def create_app(
    *,
    lakehouse: LakehouseManager | None = None,
    enable_quack: bool = True,
    frontend_dist: Path | None = None,
) -> FastAPI:
    """Create the CodeCity FastAPI Control Plane application."""
    lake = lakehouse or LakehouseManager()
    llm_cache = LlmSummaryCache(lake.data_dir / "llm_cache.sqlite")
    quack_mgr = QuackServerManager(lake) if enable_quack else None
    jobs: dict[str, AnalyzeJob] = {}
    repo_locks: dict[tuple[str, str], threading.Lock] = {}
    jobs_lock = threading.Lock()
    db_lock = threading.Lock()
    job_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="codecity-job")

    @contextmanager
    def locked_read_con(*, read_only: bool = True) -> Iterator[duckdb.DuckDBPyConnection]:
        with db_lock:
            if quack_mgr is not None:
                with quack_mgr.host_cursor() as cur:
                    yield cur
            else:
                with lake.session(read_only=read_only) as con:
                    yield con

    def _get_repo_lock(owner: str, repo: str) -> threading.Lock:
        key = (sanitize_identifier(owner), sanitize_identifier(repo))
        with jobs_lock:
            return repo_locks.setdefault(key, threading.Lock())

    @contextmanager
    def write_con() -> Iterator[tuple[duckdb.DuckDBPyConnection, str | None]]:
        if quack_mgr is not None:
            with quack_mgr.client_session(alias="remote") as client:
                yield client, f"remote.{lake.catalog_name}"
        else:
            with db_lock, lake.session() as con:
                yield con, None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if quack_mgr is not None:
            quack_mgr.start()
        try:
            yield
        finally:
            job_pool.shutdown(wait=False, cancel_futures=True)
            if quack_mgr is not None:
                quack_mgr.stop()

    app = FastAPI(title="CodeCity Control Plane", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_LOCAL_ORIGIN_RE.pattern,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _security_and_csrf_guard(request: Request, call_next: Any) -> Response:
        host_hdr = request.headers.get("host", "").strip()
        if not host_hdr or not _LOCAL_HOST_RE.fullmatch(host_hdr):
            return JSONResponse(status_code=403, content={"detail": "Untrusted Host header"})
        if request.method in _MUTATING_METHODS and request.url.path.startswith(("/api/", "/quack")):
            origin = request.headers.get("origin", "")
            sec_site = request.headers.get("sec-fetch-site", "").lower()
            if sec_site == "cross-site" or (origin and not _LOCAL_ORIGIN_RE.match(origin)):
                return JSONResponse(status_code=403, content={"detail": "Cross-origin rejected"})
        resp: Response = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith(("/api/", "/quack")):
            resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    @app.exception_handler(duckdb.CatalogException)
    def _handle_duckdb_missing(_: Request, __: duckdb.CatalogException) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": "Repository or table not found"})

    @app.exception_handler(duckdb.Error)
    def _handle_duckdb_error(_: Request, __: duckdb.Error) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": "Database operation failed"})

    def _run_job(job: AnalyzeJob, req: AnalyzeRequest, repo_lock: threading.Lock) -> None:
        def on_prog(evt: dict[str, Any]) -> None:
            with job.lock:
                job.events.append(evt)

        try:
            with repo_lock:
                with job.lock:
                    job.status = "running"
                summary = analyze_repository(
                    req.source,
                    lakehouse=lake,
                    quack_server=quack_mgr,
                    owner=job.owner,
                    repo=job.repo,
                    max_keyframes=req.max_keyframes,
                    workers=req.workers,
                    semantic=req.semantic,
                    llm_mode=req.llm_mode,
                    on_progress=on_prog,
                )
            with job.lock:
                job.status = "completed"
                job.events.append(
                    {
                        "stage": "completed",
                        "message": f"Completed {summary.repo.owner}/{summary.repo.repo}",
                        "percent": 100.0,
                        "owner": summary.repo.owner,
                        "repo": summary.repo.repo,
                    }
                )
        except Exception as exc:  # pragma: no cover - surfaced via job state
            safe_err = (
                str(exc).replace(str(lake.data_dir), "<catalog>")[:240]
                if isinstance(exc, (ValueError, FileNotFoundError))
                else f"Analysis failed ({type(exc).__name__})"
            )
            with job.lock:
                job.status = "failed"
                job.error = safe_err
                job.events.append({"stage": "error", "message": safe_err, "percent": 100.0})

    def _resolve_repo_path(owner: str, repo: str) -> Path:
        with locked_read_con() as con:
            matched = lake.get_repo(con, owner, repo)
        if matched is None:
            raise HTTPException(status_code=404, detail="Repository not found")
        try:
            return resolve_git_repo(matched.repo_url_or_path, lake.data_dir / "clones")
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=404, detail="Repository source unavailable") from exc

    def _safe_export_dir(owner: str, repo: str) -> Path:
        exports_root = (lake.data_dir / "exports").resolve()
        slug = f"{sanitize_identifier(owner)}_{sanitize_identifier(repo)}"
        dest = (exports_root / slug).resolve()
        if not dest.is_relative_to(exports_root):
            raise HTTPException(status_code=400, detail="Invalid export target")
        return dest

    def _compute_fan_in(owner: str, repo: str, target_path: str) -> int:
        with locked_read_con() as con:
            pfx = lake.schema_prefix(owner, repo)
            try:
                row = con.execute(
                    f"""
                    SELECT COUNT(*) FROM {pfx}.file_imports
                    WHERE snapshot_idx = (
                        SELECT COALESCE(MAX(snapshot_idx), 0) FROM {pfx}.snapshots
                    )
                      AND target_file = ?;
                    """,
                    [target_path],
                ).fetchone()
            except duckdb.Error:
                return 0
        return int(row[0]) if row else 0

    def _read_repo_file_at(
        repo_path: Path,
        file_path: str,
        commit_sha: str | None = None,
    ) -> tuple[str, str]:
        try:
            target = safe_repo_target(repo_path, file_path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        rel = target.relative_to(repo_path.resolve()).as_posix()

        sha = commit_sha.strip() if commit_sha else ""
        if sha and sha.upper() != "HEAD":
            if not _COMMIT_SHA_RE.fullmatch(sha):
                raise HTTPException(status_code=400, detail="Invalid commit SHA")
            proc = run_git(repo_path, ["show", f"{sha}:{rel}"], check=False, timeout=15)
            if proc.returncode != 0:
                raise HTTPException(status_code=404, detail="File not found in snapshot")
            raw = proc.stdout
            if "\x00" in raw[:1024]:
                raise HTTPException(status_code=400, detail="Binary file cannot be displayed")
            return rel, raw[:MAX_ANALYZED_FILE_BYTES]

        if not target.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        with target.open("rb") as fh:
            raw_bytes = fh.read(MAX_ANALYZED_FILE_BYTES + 1024)
        if b"\x00" in raw_bytes[:1024]:
            raise HTTPException(status_code=400, detail="Binary file cannot be displayed")
        return rel, raw_bytes[:MAX_ANALYZED_FILE_BYTES].decode("utf-8", errors="replace")

    @app.get("/api/health")
    def api_health() -> dict[str, Any]:
        ep = quack_mgr.endpoint if quack_mgr else None
        return {
            "status": "ok",
            "duckdb_version": duckdb.__version__,
            "quack_enabled": quack_mgr is not None,
            "quack_uri": ep.quack_uri if ep else None,
            **describe_llm_status(),
        }

    @app.post("/api/analyze")
    def start_analyze(req: AnalyzeRequest) -> dict[str, str]:
        owner, repo = infer_owner_repo(req.source, owner=req.owner, repo=req.repo)
        job_id = uuid.uuid4().hex[:12]
        job = AnalyzeJob(job_id=job_id, owner=owner, repo=repo)
        repo_lock = _get_repo_lock(owner, repo)
        with jobs_lock:
            if len(jobs) >= _MAX_JOBS_RETAINED:
                for old_id in list(jobs):
                    if jobs[old_id].status in {"completed", "failed"}:
                        del jobs[old_id]
                        if len(jobs) < _MAX_JOBS_RETAINED:
                            break
            jobs[job_id] = job
        job_pool.submit(_run_job, job, req, repo_lock)
        return {"job_id": job_id, "owner": owner, "repo": repo}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        with jobs_lock:
            job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        with job.lock:
            return {
                "job_id": job.job_id,
                "owner": job.owner,
                "repo": job.repo,
                "status": job.status,
                "error": job.error,
                "events": list(job.events),
            }

    @app.get("/api/jobs/{job_id}/events")
    async def stream_job_events(job_id: str) -> StreamingResponse:
        with jobs_lock:
            job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        async def event_gen() -> AsyncIterator[bytes]:
            cursor = 0
            while True:
                with job.lock:
                    batch = job.events[cursor:]
                    cursor = len(job.events)
                    done = job.status in {"completed", "failed"}
                for evt in batch:
                    yield f"event: progress\ndata: {json.dumps(evt)}\n\n".encode()
                if done:
                    break
                await asyncio.sleep(0.15)

        return StreamingResponse(
            event_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/repos")
    def api_list_repos() -> list[dict[str, Any]]:
        with locked_read_con(read_only=False) as con:
            return [r.model_dump() for r in lake.list_repos(con)]

    @app.get("/api/repos/{owner}/{repo}/parquet/{table_name}.parquet")
    def api_repo_parquet(owner: str, repo: str, table_name: str) -> Response:
        if table_name not in EXPORT_TABLES:
            raise HTTPException(status_code=404, detail="Unknown table")
        with tempfile.TemporaryDirectory(prefix="codecity_pq_") as td:
            dest = Path(td) / f"{table_name}.parquet"
            with locked_read_con() as con:
                lake.export_table_parquet(con, owner, repo, table_name, dest)
            data = dest.read_bytes()
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/repos/{owner}/{repo}/briefing")
    def api_repo_briefing(
        owner: str,
        repo: str,
        enhance_llm: bool = False,
    ) -> dict[str, Any]:
        with locked_read_con() as con:
            matched = lake.get_repo(con, owner, repo)
            if matched is None:
                raise HTTPException(status_code=404, detail="Repository not found")
            pfx = lake.schema_prefix(owner, repo)
            snap_cols = {
                str(r[0]).lower() for r in con.execute(f"DESCRIBE {pfx}.snapshots;").fetchall()
            }
            if "city_briefing" in snap_cols:
                row = con.execute(
                    f"""
                    SELECT snapshot_idx, city_archetype_title, health_grade,
                           to_json(city_briefing)::VARCHAR
                    FROM {pfx}.snapshots
                    ORDER BY snapshot_idx DESC LIMIT 1;
                    """
                ).fetchone()
            else:
                row = con.execute(
                    f"""
                    SELECT snapshot_idx, city_archetype_title, health_grade, NULL::VARCHAR
                    FROM {pfx}.snapshots
                    ORDER BY snapshot_idx DESC LIMIT 1;
                    """
                ).fetchone()

            if not row:
                raise HTTPException(status_code=404, detail="No snapshots found")

            latest_idx = int(row[0])
            city_title = str(row[1] or "")
            health_grade = str(row[2] or "A")
            raw_briefing = row[3]

            if raw_briefing:
                stored = CityBriefing.model_validate_json(str(raw_briefing))
                if not enhance_llm or stored.source in {"llamacpp", "gemini"}:
                    return stored.model_dump(mode="json")

            dist_rows = con.execute(
                f"""
                SELECT snapshot_idx, district_path, display_name, zone_type,
                       bounds_x, bounds_z, bounds_w, bounds_d,
                       file_count, avg_health, summary_blurb
                FROM {pfx}.districts WHERE snapshot_idx = ? ORDER BY district_path;
                """,
                [latest_idx],
            ).fetchall()
            file_rows = con.execute(
                f"""
                SELECT snapshot_idx, file_path, district_path, language, zone_type,
                       building_archetype, sloc, to_json(role_signals)::VARCHAR,
                       to_json(condition_flags)::VARCHAR
                FROM {pfx}.file_metrics WHERE snapshot_idx = ? ORDER BY file_path;
                """,
                [latest_idx],
            ).fetchall()
            imp_rows = con.execute(
                f"SELECT snapshot_idx, source_file, target_file FROM {pfx}.file_imports "
                f"WHERE snapshot_idx = ?;",
                [latest_idx],
            ).fetchall()

        districts = [
            District(
                snapshot_idx=int(r[0]),
                district_path=str(r[1]),
                display_name=str(r[2]),
                zone_type=ZoneType(str(r[3])),
                bounds_x=float(r[4]),
                bounds_z=float(r[5]),
                bounds_w=float(r[6]),
                bounds_d=float(r[7]),
                file_count=int(r[8]),
                avg_health=float(r[9]),
                summary_blurb=str(r[10] or ""),
            )
            for r in dist_rows
        ]
        files = [
            FileMetric(
                snapshot_idx=int(r[0]),
                file_path=str(r[1]),
                district_path=str(r[2]),
                language=str(r[3]),
                zone_type=ZoneType(str(r[4])),
                building_archetype=BuildingArchetype(str(r[5])),
                sloc=int(r[6]),
                role_signals=json.loads(r[7]) if r[7] else {},
                condition_flags=json.loads(r[8]) if r[8] else {},
            )
            for r in file_rows
        ]
        imports = [
            FileImport(snapshot_idx=int(r[0]), source_file=str(r[1]), target_file=str(r[2]))
            for r in imp_rows
        ]

        repo_path = _resolve_repo_path(owner, repo)
        docs_ctx = extract_repo_docs_context(repo_path)
        repo_slug = f"{matched.owner}/{matched.repo}"
        briefing = build_city_briefing(
            repo_slug,
            docs_ctx,
            districts,
            files,
            imports,
            city_title=city_title,
            health_grade=health_grade,
        )
        if enhance_llm:
            briefing = enhance_city_briefing_with_llm(
                briefing,
                docs_ctx,
                repo_slug=repo_slug,
                cache=llm_cache,
            )
        return briefing.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/file-details")
    def api_file_details(
        owner: str,
        repo: str,
        file_path: str,
        commit_sha: str | None = None,
        enhance_llm: bool = False,
    ) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        rel, source_text = _read_repo_file_at(repo_path, file_path, commit_sha)

        stored_desc: BuildingDescription | None = None
        fan_in = 0
        fan_out = 0
        churn_90d = 0
        bugfix_commits_90d = 0
        distinct_authors_90d = 1
        internal_targets: list[str] = []
        external_deps: list[ExternalDep] = []
        stored_archetype: BuildingArchetype | None = None
        stored_zone: ZoneType | None = None

        with locked_read_con() as con:
            matched = lake.get_repo(con, owner, repo)
            if matched is not None:
                pfx = lake.schema_prefix(owner, repo)
                target_snap = None
                if commit_sha and commit_sha.strip().upper() != "HEAD":
                    snap_row = con.execute(
                        f"SELECT snapshot_idx FROM {pfx}.snapshots WHERE commit_sha = ? LIMIT 1;",
                        [commit_sha.strip()],
                    ).fetchone()
                    if snap_row:
                        target_snap = int(snap_row[0])
                if target_snap is None:
                    snap_row = con.execute(
                        f"SELECT COALESCE(MAX(snapshot_idx), 0) FROM {pfx}.snapshots;"
                    ).fetchone()
                    target_snap = int(snap_row[0]) if snap_row else 0

                fm_row = con.execute(
                    f"""
                    SELECT zone_type, building_archetype, churn_90d, bugfix_commits_90d,
                           distinct_authors_90d, to_json(role_signals)::VARCHAR,
                           to_json(condition_flags)::VARCHAR
                    FROM {pfx}.file_metrics
                    WHERE snapshot_idx = ? AND file_path = ? LIMIT 1;
                    """,
                    [target_snap, rel],
                ).fetchone()
                if fm_row:
                    stored_zone = ZoneType(str(fm_row[0]))
                    stored_archetype = BuildingArchetype(str(fm_row[1]))
                    churn_90d = int(fm_row[2] or 0)
                    bugfix_commits_90d = int(fm_row[3] or 0)
                    distinct_authors_90d = int(fm_row[4] or 1)
                    raw_sig = json.loads(fm_row[5]) if fm_row[5] else {}
                    flags = json.loads(fm_row[6]) if fm_row[6] else {}
                    fan_in = int(flags.get("fan_in", 0) or 0)
                    fan_out = int(flags.get("fan_out", 0) or 0)
                    if isinstance(raw_sig.get("description"), dict):
                        stored_desc = BuildingDescription.model_validate(raw_sig["description"])

                imp_rows = con.execute(
                    f"SELECT target_file FROM {pfx}.file_imports "
                    f"WHERE snapshot_idx = ? AND source_file = ?;",
                    [target_snap, rel],
                ).fetchall()
                internal_targets = [str(r[0]) for r in imp_rows]
                dep_rows = con.execute(
                    f"SELECT snapshot_idx, ecosystem, package_name, version, is_direct "
                    f"FROM {pfx}.external_deps WHERE snapshot_idx = ?;",
                    [target_snap],
                ).fetchall()
                external_deps = [
                    ExternalDep(
                        snapshot_idx=int(r[0]),
                        ecosystem=str(r[1]),
                        package_name=str(r[2]),
                        version=str(r[3] or ""),
                        is_direct=bool(r[4]),
                    )
                    for r in dep_rows
                ]

        docs_ctx = extract_repo_docs_context(repo_path)
        repo_slug = f"{sanitize_identifier(owner)}/{sanitize_identifier(repo)}"

        if stored_desc is not None and (
            not enhance_llm or stored_desc.source in {"llamacpp", "gemini"}
        ):
            return stored_desc.model_dump(mode="json")

        if stored_desc is not None:
            desc = stored_desc
        else:
            ast_info = analyze_file_ast(rel, source_text)
            if stored_archetype is None or stored_zone is None:
                stored_archetype, stored_zone, _, _ = classify_building_archetype(
                    ast_info, fan_in=fan_in, fan_out=fan_out, pagerank=0.0
                )
            desc = build_file_description(
                ast_info,
                archetype=stored_archetype,
                zone=stored_zone,
                fan_in=fan_in,
                fan_out=fan_out,
                internal_targets=internal_targets,
                external_deps=external_deps,
                churn_90d=churn_90d,
                bugfix_commits_90d=bugfix_commits_90d,
                distinct_authors_90d=distinct_authors_90d,
                readme_context=match_doc_for_file(docs_ctx, rel),
            )

        if enhance_llm:
            desc = enhance_building_description_with_llm(
                desc,
                file_path=rel,
                source_text=source_text,
                repo_name=repo_slug,
                docs_ctx=docs_ctx,
                repo_slug=repo_slug,
                cache=llm_cache,
            )
        return desc.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/file-source")
    def api_file_source(
        owner: str,
        repo: str,
        file_path: str,
        commit_sha: str | None = None,
        full: bool = False,
    ) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        rel, raw = _read_repo_file_at(repo_path, file_path, commit_sha)
        lines = raw.splitlines()
        total_lines = len(lines)
        truncated = False
        content = raw
        if not full and total_lines > _INLINE_CODE_MAX_LINES:
            content = "\n".join(lines[:_INLINE_CODE_MAX_LINES])
            truncated = True
        elif len(raw.encode("utf-8", errors="ignore")) >= MAX_ANALYZED_FILE_BYTES:
            truncated = True
        return {
            "file_path": rel,
            "language": detect_language(rel)[0],
            "commit_sha": commit_sha.strip() if commit_sha else "HEAD",
            "total_lines": total_lines,
            "truncated": truncated,
            "content": content,
        }

    @app.post("/api/repos/{owner}/{repo}/fix-diff")
    def api_fix_diff(owner: str, repo: str, body: FixDiffRequest) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        try:
            result: FixDiffResult = preview_file_fix(repo_path, body.file_path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return result.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/authors")
    def api_repo_authors(owner: str, repo: str) -> list[dict[str, Any]]:
        return list_repo_authors_90d(_resolve_repo_path(owner, repo))

    @app.post("/api/repos/{owner}/{repo}/mayor/session")
    def api_mayor_session(owner: str, repo: str) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        with _get_repo_lock(owner, repo):
            try:
                return ensure_mayor_branch(repo_path)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/repos/{owner}/{repo}/mayor/execute")
    def api_mayor_execute(owner: str, repo: str, body: MayorExecuteRequest) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        fan_in = _compute_fan_in(owner, repo, body.target_path) if body.tool == "bulldozer" else 0
        with _get_repo_lock(owner, repo):
            try:
                return execute_live_mayor_tool(
                    repo_path,
                    tool=body.tool,
                    target_path=body.target_path,
                    secondary_path=body.secondary_path,
                    district_path=body.district_path,
                    fan_in=fan_in,
                    confirm=body.confirm,
                )
            except (ValueError, FileNotFoundError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/quack-snippet")
    def api_quack_snippet(owner: str, repo: str, request: Request) -> dict[str, Any]:
        raw_base = str(request.base_url).rstrip("/")
        proxy_url = f"{raw_base}/quack" if _LOCAL_ORIGIN_RE.match(raw_base) else "/quack"
        if quack_mgr and quack_mgr.endpoint:
            ep = quack_mgr.endpoint
            return {
                "quack_uri": ep.quack_uri,
                "token": ep.token,
                "proxy_url": proxy_url,
                "snippet": quack_mgr.attach_snippet(owner, repo, proxy_url=proxy_url),
            }
        return {
            "quack_uri": None,
            "token": None,
            "proxy_url": proxy_url,
            "snippet": "-- Quack server disabled in current process.",
        }

    @app.post("/api/repos/{owner}/{repo}/annotations")
    def api_add_annotation(owner: str, repo: str, body: AnnotationCreateRequest) -> dict[str, Any]:
        cleaned_body = body.body.strip()
        if not cleaned_body:
            raise HTTPException(status_code=400, detail="Annotation body cannot be empty")
        note = Annotation(
            annotation_id=f"note-{uuid.uuid4().hex[:10]}",
            file_path=body.file_path,
            author=body.author.strip() or "mayor",
            tag=body.tag.strip() or "note",
            body=cleaned_body,
            created_at=datetime.now(UTC).replace(tzinfo=None),
        )
        with write_con() as (con, pfx):
            lake.add_annotation(con, owner, repo, note, catalog_prefix=pfx)
        return note.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/annotations/changes")
    def api_annotation_changes(owner: str, repo: str) -> list[dict[str, Any]]:
        with locked_read_con() as con:
            return lake.get_annotation_changes(con, owner, repo)

    @app.get("/api/repos/{owner}/{repo}/sandbox-actions")
    def api_get_sandbox_actions(owner: str, repo: str) -> list[dict[str, Any]]:
        with locked_read_con() as con:
            actions = lake.query_sandbox_actions(con, owner, repo)
        return [a.model_dump(mode="json") for a in actions]

    @app.post("/api/repos/{owner}/{repo}/sandbox-actions")
    def api_add_sandbox_action(
        owner: str, repo: str, body: SandboxActionCreateRequest
    ) -> dict[str, Any]:
        try:
            action_id = (
                validate_action_id(body.action_id)
                if body.action_id is not None
                else f"sbx-{uuid.uuid4().hex[:10]}"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        act = SandboxAction(
            action_id=action_id,
            session_id=body.session_id,
            author=body.author.strip() or "mayor",
            tool=body.tool,
            target_path=body.target_path,
            secondary_path=body.secondary_path,
            district_path=body.district_path,
            summary=body.summary,
            velocity_cost=body.velocity_cost,
            active=True,
            created_at=datetime.now(UTC).replace(tzinfo=None),
        )
        with write_con() as (con, pfx):
            persisted = lake.add_sandbox_action(con, owner, repo, act, catalog_prefix=pfx)
        return persisted.model_dump(mode="json")

    @app.post("/api/repos/{owner}/{repo}/sandbox-actions/{action_id}/toggle")
    def api_toggle_sandbox_action(
        owner: str, repo: str, action_id: str, body: SandboxToggleRequest
    ) -> dict[str, Any]:
        with write_con() as (con, pfx):
            try:
                lake.toggle_sandbox_action(
                    con, owner, repo, action_id, body.active, catalog_prefix=pfx
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "action_id": action_id, "active": body.active}

    @app.delete("/api/repos/{owner}/{repo}/sandbox-actions")
    def api_clear_sandbox_actions(owner: str, repo: str) -> dict[str, Any]:
        with write_con() as (con, pfx):
            lake.clear_sandbox_actions(con, owner, repo, catalog_prefix=pfx)
        return {"ok": True}

    @app.get("/api/repos/{owner}/{repo}/badge.svg")
    def api_badge_svg(owner: str, repo: str) -> Response:
        with locked_read_con() as con:
            matched = lake.get_repo(con, owner, repo)
        if matched is None:
            raise HTTPException(status_code=404, detail="Repository not found")
        svg = render_grade_badge_svg(
            matched.latest_grade, matched.latest_title, matched.owner, matched.repo
        )
        return Response(
            content=svg,
            media_type="image/svg+xml",
            headers={"Content-Security-Policy": "default-src 'none'; sandbox"},
        )

    @app.post("/api/repos/{owner}/{repo}/export")
    def api_export_static(owner: str, repo: str, body: ExportRequest) -> dict[str, Any]:
        export_dir = _safe_export_dir(owner, repo)
        try:
            res = export_static_site(
                lake,
                owner,
                repo,
                export_dir,
                open_con=locked_read_con,
                with_postcard=body.with_postcard,
                frontend_dist=frontend_dist,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Repository not found") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        o_q = quote(owner, safe="")
        r_q = quote(repo, safe="")
        return {
            "output_dir": str(res.output_dir),
            "badge_url": f"/api/repos/{o_q}/{r_q}/badge.svg",
            "postcard_url": (
                f"/api/repos/{o_q}/{r_q}/exports/city-postcard.png" if res.postcard_path else None
            ),
        }

    @app.get("/api/repos/{owner}/{repo}/exports/city-postcard.png")
    def api_get_postcard(owner: str, repo: str) -> FileResponse:
        png_path = _safe_export_dir(owner, repo) / "city-postcard.png"
        if not png_path.exists():
            raise HTTPException(status_code=404, detail="Postcard not generated yet")
        return FileResponse(png_path, media_type="image/png")

    @app.api_route("/quack", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    @app.api_route("/quack/{subpath:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    async def quack_cors_proxy(request: Request, subpath: str = "") -> Response:
        if request.method == "OPTIONS":
            return Response(status_code=204)
        if quack_mgr is None or quack_mgr.endpoint is None:
            raise HTTPException(status_code=503, detail="Quack server is not active")

        clean_sub = subpath.lstrip("/")
        if (
            ".." in clean_sub.split("/")
            or "\\" in clean_sub
            or "://" in clean_sub
            or clean_sub.startswith("//")
        ):
            raise HTTPException(status_code=400, detail="Invalid proxy subpath")

        parsed = urlsplit(quack_mgr.endpoint.http_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        req_path = f"/{clean_sub}" if clean_sub else "/"
        if request.url.query:
            req_path = f"{req_path}?{request.url.query}"

        content_len = request.headers.get("content-length")
        if content_len and content_len.isdigit() and int(content_len) > _MAX_QUACK_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Request payload too large")
        raw_body = await request.body()
        if len(raw_body) > _MAX_QUACK_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Request payload too large")
        fwd_headers = {
            k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP_REQ_HEADERS
        }
        try:
            status, raw_headers, payload = await asyncio.to_thread(
                _proxy_local_http, host, port, request.method, req_path, fwd_headers, raw_body
            )
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail="Quack upstream timed out") from exc
        except (OSError, http.client.HTTPException) as exc:
            raise HTTPException(status_code=502, detail="Quack upstream unavailable") from exc

        resp_headers = {
            k: v
            for k, v in raw_headers
            if k.lower() not in _HOP_BY_HOP_RESP_HEADERS
            and not k.lower().startswith("access-control-")
        }
        return Response(content=payload, status_code=status, headers=resp_headers)

    dist_dir = frontend_dist or default_frontend_dist()
    if dist_dir.exists() and (dist_dir / "index.html").exists():
        app.mount("/", StaticFiles(directory=dist_dir, html=True), name="studio")

    return app

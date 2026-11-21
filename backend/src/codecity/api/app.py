"""FastAPI Control Plane: SSE ingestion, Quack CORS proxy, analytical SQL & live auto-fix."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb
import httpx
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from codecity.analyzer.git_history import resolve_git_repo
from codecity.analyzer.layout import compute_urban_street_grid
from codecity.analyzer.pipeline import analyze_repository
from codecity.analyzer.plugins import preview_file_fix
from codecity.api.exporter import export_static_site, render_grade_badge_svg
from codecity.api.mayor import (
    ensure_mayor_branch,
    execute_live_mayor_tool,
    get_mayor_status,
    list_repo_authors_90d,
)
from codecity.models import AnalyzeRequest, Annotation, FixDiffResult, SandboxAction
from codecity.storage.lakehouse import LakehouseManager, infer_owner_repo
from codecity.storage.quack_server import QuackServerManager
from codecity.storage.queries import (
    query_annotations,
    query_blast_radius,
    query_file_diagnostics,
    query_file_history,
    query_health_report,
    query_snapshot_bundle,
    query_snapshots,
    query_tour_landmarks,
)


class AnnotationCreateRequest(BaseModel):
    """Payload to record a collaborative Mayor Note via Quack into DuckLake."""

    file_path: str
    author: str = "mayor"
    tag: str = "note"
    body: str


class FixDiffRequest(BaseModel):
    """Payload to compute a non-destructive live auto-fix diff on HEAD."""

    file_path: str


class ExportRequest(BaseModel):
    """Payload to export a zero-backend static OSS report and optional PNG postcard."""

    with_postcard: bool = True


class MayorExecuteRequest(BaseModel):
    """Payload to execute a Mayor tool on the safe `codecity/mayor-session` branch."""

    tool: str
    target_path: str
    secondary_path: str | None = None
    district_path: str = ""
    fan_in: int = 0
    confirm: bool = False


class SandboxActionCreateRequest(BaseModel):
    """Payload to sync a Mayor Sandbox intervention via Quack + DuckLake."""

    action_id: str | None = None
    session_id: str = "default"
    author: str = "mayor"
    tool: str
    target_path: str
    secondary_path: str | None = None
    district_path: str
    summary: str
    velocity_cost: int = 0


class SandboxToggleRequest(BaseModel):
    """Payload to undo/redo a synced sandbox action."""

    active: bool


@dataclass
class AnalyzeJob:
    """In-memory state and event stream for a background repository indexing job."""

    job_id: str
    owner: str
    repo: str
    status: str = "queued"
    events: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


def create_app(
    *,
    lakehouse: LakehouseManager | None = None,
    enable_quack: bool = True,
    frontend_dist: Path | None = None,
) -> FastAPI:
    """Create the CodeCity FastAPI Control Plane application."""
    lake = lakehouse or LakehouseManager()
    quack_mgr = QuackServerManager(lake) if enable_quack else None
    jobs: dict[str, AnalyzeJob] = {}
    jobs_lock = threading.Lock()
    # Serialize direct DuckDB reads safely across request threads when needed
    db_lock = threading.Lock()

    @contextmanager
    def open_con(*, read_only: bool = True) -> Iterator[duckdb.DuckDBPyConnection]:
        if quack_mgr is not None:
            with quack_mgr.host_cursor() as cur:
                yield cur
        else:
            with lake.session(read_only=read_only) as con:
                yield con

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if quack_mgr is not None:
            quack_mgr.start()
        try:
            yield
        finally:
            if quack_mgr is not None:
                quack_mgr.stop()

    app = FastAPI(
        title="CodeCity Control Plane",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def _run_job(job: AnalyzeJob, req: AnalyzeRequest) -> None:
        def on_prog(evt: dict[str, Any]) -> None:
            with job.lock:
                job.events.append(evt)

        try:
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
            with job.lock:
                job.status = "failed"
                job.error = str(exc)
                job.events.append(
                    {
                        "stage": "error",
                        "message": str(exc),
                        "percent": 100.0,
                    }
                )

    @app.get("/api/health")
    def api_health() -> dict[str, Any]:
        ep = quack_mgr.endpoint if quack_mgr else None
        return {
            "status": "ok",
            "duckdb_version": duckdb.__version__,
            "quack_enabled": quack_mgr is not None,
            "quack_uri": ep.quack_uri if ep else None,
            "quack_http_url": ep.http_url if ep else None,
        }

    @app.post("/api/analyze")
    def start_analyze(req: AnalyzeRequest) -> dict[str, str]:
        owner, repo = infer_owner_repo(req.source, owner=req.owner, repo=req.repo)
        job_id = uuid.uuid4().hex[:12]
        job = AnalyzeJob(job_id=job_id, owner=owner, repo=repo)
        with jobs_lock:
            jobs[job_id] = job
        thread = threading.Thread(target=_run_job, args=(job, req), daemon=True)
        thread.start()
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
    async def stream_job_events(job_id: str) -> EventSourceResponse:
        with jobs_lock:
            job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        async def event_gen() -> AsyncIterator[dict[str, str]]:
            cursor = 0
            while True:
                with job.lock:
                    batch = job.events[cursor:]
                    cursor = len(job.events)
                    status = job.status
                for evt in batch:
                    yield {"event": "progress", "data": json.dumps(evt)}
                if status in {"completed", "failed"} and cursor >= len(job.events):
                    break
                await asyncio.sleep(0.15)

        return EventSourceResponse(event_gen())

    @app.get("/api/repos")
    def api_list_repos() -> list[dict[str, Any]]:
        with db_lock, open_con(read_only=False) as con:
            return [r.model_dump() for r in lake.list_repos(con)]

    @app.get("/api/repos/{owner}/{repo}/snapshots")
    def api_snapshots(owner: str, repo: str) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                snaps = query_snapshots(con, lake, owner, repo)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return [s.model_dump(mode="json") for s in snaps]

    @app.get("/api/repos/{owner}/{repo}/snapshots/{snapshot_idx}")
    def api_snapshot_bundle(owner: str, repo: str, snapshot_idx: int) -> dict[str, Any]:
        with db_lock, open_con() as con:
            try:
                bundle = query_snapshot_bundle(con, lake, owner, repo, snapshot_idx)
            except (KeyError, duckdb.Error) as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "snapshot": bundle["snapshot"].model_dump(mode="json"),
            "districts": [d.model_dump(mode="json") for d in bundle["districts"]],
            "files": [f.model_dump(mode="json") for f in bundle["files"]],
            "imports": [i.model_dump(mode="json") for i in bundle["imports"]],
            "cochanges": [c.model_dump(mode="json") for c in bundle["cochanges"]],
            "deps": [dep.model_dump(mode="json") for dep in bundle["deps"]],
        }

    @app.get("/api/repos/{owner}/{repo}/city-grid")
    def api_city_grid(
        owner: str,
        repo: str,
        snapshot_idx: int = Query(default=0),
    ) -> dict[str, Any]:
        with db_lock, open_con() as con:
            try:
                bundle = query_snapshot_bundle(con, lake, owner, repo, snapshot_idx)
            except (KeyError, duckdb.Error) as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        grid = compute_urban_street_grid(bundle["districts"], bundle["files"])
        return asdict(grid)

    @app.get("/api/repos/{owner}/{repo}/blast-radius")
    def api_blast_radius(
        owner: str,
        repo: str,
        snapshot_idx: int = Query(...),
        file_path: str = Query(...),
    ) -> dict[str, Any]:
        with db_lock, open_con() as con:
            try:
                res = query_blast_radius(con, lake, owner, repo, snapshot_idx, file_path)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return res.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/tour")
    def api_tour(
        owner: str,
        repo: str,
        snapshot_idx: int = Query(...),
    ) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                return query_tour_landmarks(con, lake, owner, repo, snapshot_idx)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/health-report")
    def api_health_report(
        owner: str,
        repo: str,
        snapshot_idx: int = Query(default=0),
    ) -> dict[str, Any]:
        with db_lock, open_con() as con:
            try:
                return query_health_report(con, lake, owner, repo, snapshot_idx)
            except (duckdb.Error, IndexError) as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/files/history")
    def api_file_history(
        owner: str,
        repo: str,
        file_path: str = Query(...),
    ) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                return query_file_history(con, lake, owner, repo, file_path)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/files/diagnostics")
    def api_file_diagnostics(
        owner: str,
        repo: str,
        snapshot_idx: int = Query(...),
        file_path: str = Query(...),
    ) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                diags = query_file_diagnostics(con, lake, owner, repo, snapshot_idx, file_path)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return [d.model_dump(mode="json") for d in diags]

    @app.get("/api/repos/{owner}/{repo}/parquet/{table_name}.parquet")
    def api_repo_parquet(owner: str, repo: str, table_name: str) -> Response:
        valid_tables = {
            "snapshots",
            "districts",
            "file_metrics",
            "file_imports",
            "cochange_pairs",
            "external_deps",
            "lint_diagnostics",
            "annotations",
        }
        if table_name not in valid_tables:
            raise HTTPException(status_code=404, detail="Unknown table")
        with (
            db_lock,
            open_con() as con,
            tempfile.TemporaryDirectory(prefix="codecity_pq_") as td,
        ):
            pq_dir = Path(td)
            try:
                exported = lake.export_repo_parquet(con, owner, repo, pq_dir)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            data = exported[table_name].read_bytes()
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    def _resolve_repo_path(owner: str, repo: str) -> Path:
        with db_lock, open_con() as con:
            repos = lake.list_repos(con)
        matched = next((r for r in repos if r.owner == owner and r.repo == repo), None)
        if matched is None:
            raise HTTPException(status_code=404, detail="Repository not found")
        try:
            return resolve_git_repo(matched.repo_url_or_path, lake.data_dir / "clones")
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/repos/{owner}/{repo}/fix-diff")
    def api_fix_diff(owner: str, repo: str, body: FixDiffRequest) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        result: FixDiffResult = preview_file_fix(repo_path, body.file_path)
        return result.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/authors")
    def api_repo_authors(owner: str, repo: str) -> list[dict[str, Any]]:
        repo_path = _resolve_repo_path(owner, repo)
        return list_repo_authors_90d(repo_path)

    @app.post("/api/repos/{owner}/{repo}/mayor/session")
    def api_mayor_session(owner: str, repo: str) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        try:
            return ensure_mayor_branch(repo_path)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/mayor/status")
    def api_mayor_status(owner: str, repo: str) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        return get_mayor_status(repo_path)

    @app.post("/api/repos/{owner}/{repo}/mayor/execute")
    def api_mayor_execute(owner: str, repo: str, body: MayorExecuteRequest) -> dict[str, Any]:
        repo_path = _resolve_repo_path(owner, repo)
        try:
            return execute_live_mayor_tool(
                repo_path,
                tool=body.tool,
                target_path=body.target_path,
                secondary_path=body.secondary_path,
                district_path=body.district_path,
                fan_in=body.fan_in,
                confirm=body.confirm,
            )
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/quack-snippet")
    def api_quack_snippet(owner: str, repo: str, request: Request) -> dict[str, Any]:
        proxy_url = f"{str(request.base_url).rstrip('/')}/quack"
        if quack_mgr and quack_mgr.endpoint:
            snippet = quack_mgr.attach_snippet(owner, repo, proxy_url=proxy_url)
            ep = quack_mgr.endpoint
            return {
                "quack_uri": ep.quack_uri,
                "token": ep.token,
                "proxy_url": proxy_url,
                "snippet": snippet,
            }
        return {
            "quack_uri": None,
            "token": None,
            "proxy_url": proxy_url,
            "snippet": "-- Quack server disabled in current process.",
        }

    @app.get("/api/repos/{owner}/{repo}/annotations")
    def api_get_annotations(owner: str, repo: str) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                notes = query_annotations(con, lake, owner, repo)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return [n.model_dump(mode="json") for n in notes]

    @app.post("/api/repos/{owner}/{repo}/annotations")
    def api_add_annotation(
        owner: str,
        repo: str,
        body: AnnotationCreateRequest,
    ) -> dict[str, Any]:
        note = Annotation(
            annotation_id=f"note-{uuid.uuid4().hex[:10]}",
            file_path=body.file_path,
            author=body.author.strip() or "mayor",
            tag=body.tag.strip() or "note",
            body=body.body.strip(),
            created_at=datetime.now(UTC).replace(tzinfo=None),
        )
        if quack_mgr is not None:
            client = quack_mgr.connect_client(alias="remote")
            try:
                lake.add_annotation(
                    client,
                    owner,
                    repo,
                    note,
                    catalog_prefix=f"remote.{lake.catalog_name}",
                )
            finally:
                client.close()
        else:
            with db_lock, lake.session() as con:
                lake.add_annotation(con, owner, repo, note)
        return note.model_dump(mode="json")

    @app.get("/api/repos/{owner}/{repo}/annotations/changes")
    def api_annotation_changes(owner: str, repo: str) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                return lake.get_annotation_changes(con, owner, repo)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/sandbox-actions")
    def api_get_sandbox_actions(owner: str, repo: str) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                actions = lake.query_sandbox_actions(con, owner, repo)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return [a.model_dump(mode="json") for a in actions]

    @app.post("/api/repos/{owner}/{repo}/sandbox-actions")
    def api_add_sandbox_action(
        owner: str,
        repo: str,
        body: SandboxActionCreateRequest,
    ) -> dict[str, Any]:
        act = SandboxAction(
            action_id=body.action_id or f"sbx-{uuid.uuid4().hex[:10]}",
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
        if quack_mgr is not None:
            client = quack_mgr.connect_client(alias="remote")
            try:
                persisted = lake.add_sandbox_action(
                    client,
                    owner,
                    repo,
                    act,
                    catalog_prefix=f"remote.{lake.catalog_name}",
                )
            finally:
                client.close()
        else:
            with db_lock, lake.session() as con:
                persisted = lake.add_sandbox_action(con, owner, repo, act)
        return persisted.model_dump(mode="json")

    @app.post("/api/repos/{owner}/{repo}/sandbox-actions/{action_id}/toggle")
    def api_toggle_sandbox_action(
        owner: str,
        repo: str,
        action_id: str,
        body: SandboxToggleRequest,
    ) -> dict[str, Any]:
        if quack_mgr is not None:
            client = quack_mgr.connect_client(alias="remote")
            try:
                lake.toggle_sandbox_action(
                    client,
                    owner,
                    repo,
                    action_id,
                    body.active,
                    catalog_prefix=f"remote.{lake.catalog_name}",
                )
            finally:
                client.close()
        else:
            with db_lock, lake.session() as con:
                lake.toggle_sandbox_action(con, owner, repo, action_id, body.active)
        return {"ok": True, "action_id": action_id, "active": body.active}

    @app.delete("/api/repos/{owner}/{repo}/sandbox-actions")
    def api_clear_sandbox_actions(owner: str, repo: str) -> dict[str, Any]:
        if quack_mgr is not None:
            client = quack_mgr.connect_client(alias="remote")
            try:
                lake.clear_sandbox_actions(
                    client,
                    owner,
                    repo,
                    catalog_prefix=f"remote.{lake.catalog_name}",
                )
            finally:
                client.close()
        else:
            with db_lock, lake.session() as con:
                lake.clear_sandbox_actions(con, owner, repo)
        return {"ok": True}

    @app.get("/api/repos/{owner}/{repo}/sandbox-actions/changes")
    def api_sandbox_action_changes(owner: str, repo: str) -> list[dict[str, Any]]:
        with db_lock, open_con() as con:
            try:
                return lake.get_sandbox_action_changes(con, owner, repo)
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/repos/{owner}/{repo}/badge.svg")
    def api_badge_svg(owner: str, repo: str) -> Response:
        with db_lock, open_con() as con:
            try:
                snaps = query_snapshots(con, lake, owner, repo)
                latest_idx = snaps[-1].snapshot_idx if snaps else 0
                report = query_health_report(con, lake, owner, repo, latest_idx)
            except (duckdb.Error, IndexError) as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        svg = render_grade_badge_svg(
            str(report["health_grade"]),
            str(report["city_archetype_title"]),
            owner,
            repo,
        )
        return Response(content=svg, media_type="image/svg+xml")

    @app.post("/api/repos/{owner}/{repo}/export")
    def api_export_static(owner: str, repo: str, body: ExportRequest) -> dict[str, Any]:
        export_dir = lake.data_dir / "exports" / f"{owner}_{repo}"
        with db_lock, open_con() as con:
            try:
                res = export_static_site(
                    lake,
                    owner,
                    repo,
                    export_dir,
                    con=con,
                    with_postcard=body.with_postcard,
                    frontend_dist=frontend_dist,
                )
            except duckdb.Error as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "output_dir": str(res.output_dir),
            "badge_url": f"/api/repos/{owner}/{repo}/badge.svg",
            "postcard_url": (
                f"/api/repos/{owner}/{repo}/exports/city-postcard.png"
                if res.postcard_path
                else None
            ),
        }

    @app.get("/api/repos/{owner}/{repo}/exports/city-postcard.png")
    def api_get_postcard(owner: str, repo: str) -> FileResponse:
        png_path = lake.data_dir / "exports" / f"{owner}_{repo}" / "city-postcard.png"
        if not png_path.exists():
            raise HTTPException(status_code=404, detail="Postcard not generated yet")
        return FileResponse(png_path, media_type="image/png")

    @app.api_route("/quack", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    @app.api_route("/quack/{subpath:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    async def quack_cors_proxy(request: Request, subpath: str = "") -> Response:
        if request.method == "OPTIONS":
            return Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                },
            )
        if quack_mgr is None or quack_mgr.endpoint is None:
            raise HTTPException(status_code=503, detail="Quack server is not active")

        target_base = quack_mgr.endpoint.http_url.rstrip("/")
        target_url = f"{target_base}/{subpath}" if subpath else f"{target_base}/"
        if request.url.query:
            target_url = f"{target_url}?{request.url.query}"

        raw_body = await request.body()
        fwd_headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in {"host", "content-length", "connection"}
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.request(
                method=request.method,
                url=target_url,
                headers=fwd_headers,
                content=raw_body,
            )

        resp_headers = {
            k: v
            for k, v in upstream.headers.items()
            if k.lower() not in {"content-length", "transfer-encoding", "connection"}
        }
        resp_headers["Access-Control-Allow-Origin"] = "*"
        resp_headers["Access-Control-Allow-Headers"] = "*"
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=resp_headers,
        )

    # Optionally serve built frontend studio assets at `/`
    dist_dir = frontend_dist or (Path(__file__).resolve().parents[4] / "frontend" / "dist")
    if dist_dir.exists() and (dist_dir / "index.html").exists():
        assets_dir = dist_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/", include_in_schema=False)
        def serve_spa_root() -> FileResponse:
            return FileResponse(dist_dir / "index.html")

    return app

"""FastAPI control plane, Live Mayor branch safety, static export, Quack proxy & security tests."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import duckdb
import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from codecity.analyzer.plugins.base import safe_repo_target
from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
from codecity.storage.quack_server import _pick_free_port
from tests.conftest import create_polyglot_fixture_repo, git_commit


def test_safe_repo_target_rejects_traversal_and_git_paths(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("SECRET = 1\n")
    (repo / "link.py").symlink_to(outside)
    for bad in (
        "../secret.txt",
        "/etc/passwd",
        ".git/config",
        "sub/../../outside",
        "bad\npath.py",
        "link.py",
    ):
        with pytest.raises(ValueError):
            safe_repo_target(repo, bad)
    assert safe_repo_target(repo, "src/app.py") == (repo / "src" / "app.py").resolve()


def test_control_plane_mayor_export_quack_and_security(tmp_path: Path) -> None:
    repo_dir = create_polyglot_fixture_repo(tmp_path / "poly-city")
    (repo_dir / "core" / "dead_module.py").write_text("def unused_helper() -> int:\n    return 0\n")
    git_commit(repo_dir, ["add", "."])
    git_commit(repo_dir, ["commit", "-m", "chore: add dead module"])

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    app = create_app(lakehouse=lake, enable_quack=True)

    with TestClient(app) as client:
        health = client.get("/api/health").json()
        assert health["quack_enabled"] is True
        assert str(health["quack_uri"]).startswith("quack:")
        assert client.get("/api/health", headers={"Host": "evil.example:8787"}).status_code == 403

        # Quack CORS proxy allows localhost origins, rejects external origins and traversal
        q_local = client.get("/quack", headers={"Origin": "http://127.0.0.1:5173"})
        assert q_local.status_code == 200
        assert "Quack RPC endpoint" in q_local.text
        assert q_local.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"

        q_evil = client.get("/quack", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in q_evil.headers

        assert client.get("/quack/..%2Fsecret").status_code == 400

        # Background analysis job + SSE event stream
        job_id = client.post(
            "/api/analyze",
            json={
                "source": str(repo_dir),
                "owner": "acme",
                "repo": "poly-city",
                "max_keyframes": 6,
            },
        ).json()["job_id"]

        for _ in range(80):
            st = client.get(f"/api/jobs/{job_id}").json()
            if st["status"] in {"completed", "failed"}:
                break
            time.sleep(0.1)
        assert st["status"] == "completed", st.get("error")

        with client.stream("GET", f"/api/jobs/{job_id}/events") as sse_resp:
            assert sse_resp.status_code == 200
            assert "Completed acme/poly_city" in "".join(sse_resp.iter_text())

        repos = client.get("/api/repos").json()
        assert len(repos) == 1 and repos[0]["repo"] == "poly_city"

        # Briefing, file-details, and file-source endpoints + security checks
        briefing_resp = client.get("/api/repos/acme/poly_city/briefing")
        assert briefing_resp.status_code == 200
        briefing_data = briefing_resp.json()
        assert "mayor_welcome" in briefing_data and briefing_data["recommended_starts"]

        details_resp = client.get(
            "/api/repos/acme/poly_city/file-details",
            params={"file_path": "api/routes.py"},
        )
        assert details_resp.status_code == 200
        details_data = details_resp.json()
        assert details_data["short_summary"]
        assert any(s["name"] == "handle_get" for s in details_data["key_symbols"])

        src_resp = client.get(
            "/api/repos/acme/poly_city/file-source",
            params={"file_path": "api/routes.py"},
        )
        assert src_resp.status_code == 200
        src_data = src_resp.json()
        assert src_data["language"] == "python" and "def handle_get" in src_data["content"]

        assert (
            client.get(
                "/api/repos/acme/poly_city/file-source",
                params={"file_path": "../../etc/passwd"},
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/api/repos/acme/poly_city/file-source",
                params={"file_path": "api/routes.py", "commit_sha": "not-a-sha!"},
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/api/repos/acme/poly_city/file-details",
                params={"file_path": ".git/config"},
            ).status_code
            == 400
        )

        # Auto-fix diff (Python & TS) + path traversal rejection
        assert (
            client.post(
                "/api/repos/acme/poly_city/fix-diff",
                json={"file_path": "../../etc/passwd"},
            ).status_code
            == 400
        )

        fix_py = client.post(
            "/api/repos/acme/poly_city/fix-diff",
            json={"file_path": "api/routes.py"},
        ).json()
        assert fix_py["linter"] == "ruff" and fix_py["has_changes"] is True
        assert "-import os" in fix_py["diff"]

        fix_ts = client.post(
            "/api/repos/acme/poly_city/fix-diff",
            json={"file_path": "web/src/components/Card.tsx"},
        ).json()
        assert fix_ts["has_changes"] is True

        # Annotations over Quack + table_changes()
        assert (
            client.post(
                "/api/repos/acme/poly_city/annotations",
                json={
                    "file_path": "api/routes.py",
                    "author": "mayor-ada",
                    "tag": "refactor",
                    "body": "Decouple Card.tsx schema contract",
                },
            ).status_code
            == 200
        )
        changes = client.get("/api/repos/acme/poly_city/annotations/changes").json()
        assert len(changes) == 1 and changes[0]["change_type"] == "insert"

        # Single-table Parquet export endpoint
        pq_resp = client.get("/api/repos/acme/poly_city/parquet/snapshots.parquet")
        assert pq_resp.status_code == 200
        pq_file = tmp_path / "dl_snapshots.parquet"
        pq_file.write_bytes(pq_resp.content)
        plain = duckdb.connect()
        try:
            assert plain.execute(f"SELECT COUNT(*) FROM read_parquet('{pq_file}')").fetchone() == (
                4,
            )
        finally:
            plain.close()

        # Badge SVG (sandboxed CSP) + sanitized error + static export + Playwright PNG postcard
        badge = client.get("/api/repos/acme/poly_city/badge.svg")
        assert badge.status_code == 200 and "<svg" in badge.text
        assert "sandbox" in badge.headers.get("content-security-policy", "")
        assert badge.headers.get("x-content-type-options") == "nosniff"

        missing = client.get("/api/repos/ghost/nope/parquet/snapshots.parquet")
        assert missing.status_code == 404
        assert "metadata.ducklake" not in missing.text and str(tmp_path) not in missing.text
        ghost_exp = client.post("/api/repos/ghost/nope/export", json={"with_postcard": False})
        assert ghost_exp.status_code == 404
        assert not (lake.data_dir / "exports" / "ghost_nope").exists()

        exp = client.post("/api/repos/acme/poly_city/export", json={"with_postcard": True})
        assert exp.status_code == 200
        exp_data = exp.json()
        assert exp_data["badge_url"] == "/api/repos/acme/poly_city/badge.svg"
        assert exp_data["postcard_url"] == "/api/repos/acme/poly_city/exports/city-postcard.png"
        out_dir = Path(exp_data["output_dir"])
        assert (out_dir / "index.html").exists()
        assert (out_dir / "data" / "manifest.json").exists()
        assert (out_dir / "badge.svg").exists()

        postcard = client.get(exp_data["postcard_url"])
        assert postcard.status_code == 200 and len(postcard.content) > 15_000

        assert (
            client.get(
                "/api/repos/acme/poly_city/quack-snippet",
                headers={"Host": "rebind.evil"},
            ).status_code
            == 403
        )
        # CSRF guard + Live Mayor branch execution + server-side fan-in guard
        assert (
            client.post(
                "/api/repos/acme/poly_city/mayor/session",
                headers={"Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/repos/acme/poly_city/mayor/session",
                headers={"Sec-Fetch-Site": "cross-site"},
            ).status_code
            == 403
        )
        authors = client.get("/api/repos/acme/poly_city/authors").json()
        assert len(authors) >= 1

        sess = client.post("/api/repos/acme/poly_city/mayor/session")
        assert sess.status_code == 200 and sess.json()["branch"] == "codecity/mayor-session"

        sweep = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "sweeper", "target_path": "api/routes.py"},
        ).json()
        assert sweep["committed"] is True

        park = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "proving_park", "target_path": "core/engine.py"},
        ).json()
        assert (repo_dir / park["target_path"]).exists()

        owners = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "co_maintainer", "target_path": "api/routes.py"},
        ).json()
        assert owners["committed"] and (repo_dir / ".github" / "CODEOWNERS").exists()

        split = client.post(
            "/api/repos/acme/poly_city/mayor/execute",
            json={"tool": "splitter", "target_path": "core/engine.py"},
        ).json()
        assert split["committed"] and (repo_dir / split["target_path"]).exists()

        # Bulldozer computes fan_in from DuckLake server-side and blocks deleting core/engine.py
        assert (
            client.post(
                "/api/repos/acme/poly_city/mayor/execute",
                json={"tool": "bulldozer", "target_path": "core/engine.py", "confirm": True},
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/repos/acme/poly_city/mayor/execute",
                json={"tool": "bulldozer", "target_path": "core/dead_module.py", "confirm": True},
            ).status_code
            == 200
        )
        assert not (repo_dir / "core" / "dead_module.py").exists()

        # Co-Op Sandbox actions CRUD + action_id validation
        assert (
            client.post(
                "/api/repos/acme/poly_city/sandbox-actions",
                json={
                    "action_id": "bad'id",
                    "tool": "sweeper",
                    "target_path": "api/routes.py",
                    "district_path": "api",
                    "summary": "bad id",
                    "velocity_cost": 10,
                },
            ).status_code
            == 400
        )
        sbx = client.post(
            "/api/repos/acme/poly_city/sandbox-actions",
            json={
                "author": "teammate-ada",
                "tool": "sweeper",
                "target_path": "api/routes.py",
                "district_path": "api",
                "summary": "Cleaned unused import",
                "velocity_cost": 10,
            },
        )
        assert sbx.status_code == 200
        action_id = sbx.json()["action_id"]
        assert len(client.get("/api/repos/acme/poly_city/sandbox-actions").json()) == 1
        assert (
            client.post(
                f"/api/repos/acme/poly_city/sandbox-actions/{action_id}/toggle",
                json={"active": False},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/repos/acme/poly_city/sandbox-actions/bad'id/toggle",
                json={"active": False},
            ).status_code
            == 400
        )
        assert client.delete("/api/repos/acme/poly_city/sandbox-actions").status_code == 200
        assert client.get("/api/repos/acme/poly_city/sandbox-actions").json() == []


def test_shutdown_endpoint_security_and_callback(tmp_path: Path) -> None:
    lake = LakehouseManager(data_dir=tmp_path / "lake_disabled")
    disabled_app = create_app(lakehouse=lake, enable_quack=False)
    with TestClient(disabled_app) as client:
        assert client.post("/api/shutdown").status_code == 501
        assert (
            client.post("/api/shutdown", headers={"Origin": "https://evil.example"}).status_code
            == 403
        )
        assert (
            client.post("/api/shutdown", headers={"Sec-Fetch-Site": "cross-site"}).status_code
            == 403
        )
        assert (
            client.post("/api/shutdown", headers={"Host": "evil.example:8787"}).status_code == 403
        )

    triggered = threading.Event()
    shutdown_evt = threading.Event()
    enabled_app = create_app(
        lakehouse=LakehouseManager(data_dir=tmp_path / "lake_enabled"),
        enable_quack=False,
        shutdown_event=shutdown_evt,
        on_shutdown_request=triggered.set,
    )
    with TestClient(enabled_app) as client:
        resp = client.post("/api/shutdown")
        assert resp.status_code == 200
        assert resp.json() == {"status": "shutting_down"}
        assert shutdown_evt.is_set()
        assert triggered.wait(timeout=1.5)


def test_presence_auto_exit_reconnect_job_defer_and_job_sse_shutdown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    triggered = threading.Event()
    shutdown_evt = threading.Event()
    job_started = threading.Event()
    release_job = threading.Event()

    def _blocking_analyze(*_args: object, **_kwargs: object) -> object:
        job_started.set()
        release_job.wait(timeout=5.0)
        raise ValueError("cancelled for test")

    monkeypatch.setattr("codecity.api.app.analyze_repository", _blocking_analyze)

    port = _pick_free_port()
    app = create_app(
        lakehouse=LakehouseManager(data_dir=tmp_path / "lake_presence"),
        enable_quack=False,
        shutdown_event=shutdown_evt,
        on_shutdown_request=triggered.set,
        auto_exit=True,
        auto_exit_grace=0.35,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            timeout_graceful_shutdown=2,
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"

    try:
        for _ in range(50):
            try:
                if httpx.get(f"{base_url}/api/health", timeout=0.5).status_code == 200:
                    break
            except Exception:
                time.sleep(0.05)

        # Before any browser connects, auto-exit must NOT fire
        time.sleep(0.45)
        assert not triggered.is_set()

        # Connect presence SSE, then disconnect and reconnect inside the grace window
        with httpx.stream("GET", f"{base_url}/api/client/session", timeout=3.0) as resp:
            assert resp.status_code == 200
            lines = resp.iter_lines()
            assert next(lines) == ": connected"

        time.sleep(0.1)
        assert not triggered.is_set()

        # Reconnect before 0.35s grace expires -> cancels auto-exit
        with httpx.stream("GET", f"{base_url}/api/client/session", timeout=3.0) as resp:
            assert resp.status_code == 200
            lines = resp.iter_lines()
            assert next(lines) == ": connected"
            time.sleep(0.45)
            assert not triggered.is_set()

            # Start a blocking job so we verify auto-exit defers while a job runs
            job_id = httpx.post(
                f"{base_url}/api/analyze",
                json={"source": str(tmp_path), "owner": "acme", "repo": "demo"},
                timeout=2.0,
            ).json()["job_id"]
            assert job_started.wait(timeout=2.0)

        # All clients disconnected, but job is still running -> auto-exit defers
        time.sleep(0.5)
        assert not triggered.is_set()

        # Open job SSE stream, then finish job -> auto-exit fires and closes job SSE cleanly
        sse_done = threading.Event()

        def _consume_job_sse() -> None:
            with httpx.stream("GET", f"{base_url}/api/jobs/{job_id}/events", timeout=3.0) as resp:
                for _ in resp.iter_lines():
                    pass
            sse_done.set()

        sse_thread = threading.Thread(target=_consume_job_sse, daemon=True)
        sse_thread.start()

        release_job.set()
        assert sse_done.wait(timeout=3.0)
        assert triggered.wait(timeout=2.5)
        assert shutdown_evt.is_set()
    finally:
        release_job.set()
        shutdown_evt.set()
        server.should_exit = True
        thread.join(timeout=5)


def test_job_events_stream_exits_promptly_on_shutdown_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shutdown_evt = threading.Event()
    job_started = threading.Event()
    release_job = threading.Event()

    def _blocking_analyze(*_args: object, **_kwargs: object) -> object:
        job_started.set()
        release_job.wait(timeout=5.0)
        raise ValueError("stopped")

    monkeypatch.setattr("codecity.api.app.analyze_repository", _blocking_analyze)

    port = _pick_free_port()
    app = create_app(
        lakehouse=LakehouseManager(data_dir=tmp_path / "lake_sse"),
        enable_quack=False,
        shutdown_event=shutdown_evt,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            timeout_graceful_shutdown=2,
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"

    try:
        for _ in range(50):
            try:
                if httpx.get(f"{base_url}/api/health", timeout=0.5).status_code == 200:
                    break
            except Exception:
                time.sleep(0.05)

        job_id = httpx.post(
            f"{base_url}/api/analyze",
            json={"source": str(tmp_path), "owner": "acme", "repo": "hang"},
            timeout=2.0,
        ).json()["job_id"]
        assert job_started.wait(timeout=2.0)

        stream_finished = threading.Event()

        def _stream() -> None:
            with httpx.stream("GET", f"{base_url}/api/jobs/{job_id}/events", timeout=3.0) as resp:
                for _ in resp.iter_lines():
                    pass
            stream_finished.set()

        t = threading.Thread(target=_stream, daemon=True)
        t.start()
        time.sleep(0.15)
        assert not stream_finished.is_set()

        shutdown_evt.set()
        assert stream_finished.wait(timeout=1.5)
    finally:
        release_job.set()
        shutdown_evt.set()
        server.should_exit = True
        thread.join(timeout=5)

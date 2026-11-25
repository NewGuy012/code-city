"""FastAPI control plane, Live Mayor branch safety, static export, Quack proxy & security tests."""

from __future__ import annotations

import time
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient

from codecity.analyzer.plugins.base import safe_repo_target
from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
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

"""Phase 2 tests: FastAPI Control Plane, recursive blast radius, live fix diff & Quack proxy."""

from __future__ import annotations

import time
from pathlib import Path

import duckdb
from fastapi.testclient import TestClient

from codecity.api.app import create_app
from codecity.storage.lakehouse import LakehouseManager
from tests.test_phase1_polyglot_analyzer import _create_polyglot_fixture_repo


def test_fastapi_control_plane_endpoints_blast_radius_fix_and_quack_proxy(tmp_path: Path) -> None:
    repo_dir = tmp_path / "poly-city"
    _create_polyglot_fixture_repo(repo_dir)

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    app = create_app(lakehouse=lake, enable_quack=True)

    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        hdata = health.json()
        assert hdata["quack_enabled"] is True
        assert str(hdata["quack_uri"]).startswith("quack:")

        # Quack CORS proxy forwards live traffic to quack_serve()
        qproxy = client.get("/quack")
        assert qproxy.status_code == 200
        assert "Quack RPC endpoint" in qproxy.text
        assert qproxy.headers.get("access-control-allow-origin") == "*"

        # Kick off background analysis job via POST /api/analyze
        start = client.post(
            "/api/analyze",
            json={
                "source": str(repo_dir),
                "owner": "acme",
                "repo": "poly-city",
                "max_keyframes": 6,
                "workers": 2,
            },
        )
        assert start.status_code == 200
        job_id = start.json()["job_id"]

        # Poll job completion (and verify SSE endpoint streams events)
        for _ in range(80):
            st = client.get(f"/api/jobs/{job_id}").json()
            if st["status"] in {"completed", "failed"}:
                break
            time.sleep(0.1)
        assert st["status"] == "completed", st.get("error")
        assert any(evt["stage"] == "done" for evt in st["events"])

        with client.stream("GET", f"/api/jobs/{job_id}/events") as sse_resp:
            assert sse_resp.status_code == 200
            body_text = "".join(sse_resp.iter_text())
            assert "Completed acme/poly_city" in body_text

        repos = client.get("/api/repos").json()
        assert len(repos) == 1
        assert repos[0]["owner"] == "acme"
        assert repos[0]["repo"] == "poly_city"

        snaps = client.get("/api/repos/acme/poly_city/snapshots").json()
        assert len(snaps) == 3
        latest_idx = snaps[-1]["snapshot_idx"]

        bundle = client.get(f"/api/repos/acme/poly_city/snapshots/{latest_idx}").json()
        assert len(bundle["districts"]) >= 3
        assert len(bundle["files"]) >= 10

        # Recursive CTE Blast Radius: db/store.py -> core/engine.py (hop 1) -> api/routes.py (hop 2)
        blast = client.get(
            "/api/repos/acme/poly_city/blast-radius",
            params={"snapshot_idx": latest_idx, "file_path": "db/store.py"},
        ).json()
        impacted = {n["file_path"]: n["hop_distance"] for n in blast["impacted_files"]}
        assert impacted.get("core/engine.py") == 1
        assert impacted.get("api/routes.py") == 2

        # Mayor's Tour & Health Report
        tour = client.get(
            "/api/repos/acme/poly_city/tour",
            params={"snapshot_idx": latest_idx},
        ).json()
        assert 3 <= len(tour) <= 5

        report = client.get(
            "/api/repos/acme/poly_city/health-report",
            params={"snapshot_idx": latest_idx},
        ).json()
        assert report["health_grade"]
        assert "python" in report["language_breakdown"]

        # Live auto-fix diff via Ruff (api/routes.py has unused `import os`)
        fix_py = client.post(
            "/api/repos/acme/poly_city/fix-diff",
            json={"file_path": "api/routes.py"},
        ).json()
        assert fix_py["linter"] == "ruff"
        assert fix_py["has_changes"] is True
        assert "-import os" in fix_py["diff"]

        # Live auto-fix diff via Bun / oxlint + bun fmt (Card.tsx is unformatted + debugger)
        fix_ts = client.post(
            "/api/repos/acme/poly_city/fix-diff",
            json={"file_path": "web/src/components/Card.tsx"},
        ).json()
        assert fix_ts["has_changes"] is True

        # Live Mayor Note written over Quack -> DuckLake + table_changes()
        note_resp = client.post(
            "/api/repos/acme/poly_city/annotations",
            json={
                "file_path": "api/routes.py",
                "author": "mayor-ada",
                "tag": "refactor",
                "body": "Decouple Card.tsx schema contract",
            },
        )
        assert note_resp.status_code == 200
        notes = client.get("/api/repos/acme/poly_city/annotations").json()
        assert len(notes) == 1
        assert notes[0]["author"] == "mayor-ada"

        changes = client.get("/api/repos/acme/poly_city/annotations/changes").json()
        assert len(changes) == 1
        assert changes[0]["change_type"] == "insert"

        # Parquet endpoint for browser DuckDB-Wasm CityDataClient
        pq_resp = client.get("/api/repos/acme/poly_city/parquet/snapshots.parquet")
        assert pq_resp.status_code == 200
        pq_file = tmp_path / "dl_snapshots.parquet"
        pq_file.write_bytes(pq_resp.content)
        plain = duckdb.connect()
        try:
            cnt = plain.execute(f"SELECT COUNT(*) FROM read_parquet('{pq_file}')").fetchone()
            assert cnt == (3,)
        finally:
            plain.close()

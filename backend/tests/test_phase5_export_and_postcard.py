"""Phase 5 tests: Static OSS report exporter, SVG badge, semantic docs & Playwright postcard."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from codecity.analyzer.pipeline import analyze_repository
from codecity.api.app import create_app
from codecity.api.exporter import export_static_site
from codecity.storage.lakehouse import LakehouseManager
from tests.test_phase1_polyglot_analyzer import _create_polyglot_fixture_repo


def test_static_export_semantic_and_playwright_postcard(tmp_path: Path) -> None:
    repo_dir = tmp_path / "poly-city"
    _create_polyglot_fixture_repo(repo_dir)
    (repo_dir / "README.md").write_text(
        "# Poly City\n\n"
        "The `api` district routes incoming HTTP requests and coordinates core workflows.\n"
    )

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    summary = analyze_repository(
        str(repo_dir),
        lakehouse=lake,
        owner="acme",
        repo="poly-city",
        max_keyframes=4,
        workers=2,
        semantic=True,
    )
    assert summary.snapshots_written >= 3

    export_dir = tmp_path / "static-site"
    res = export_static_site(
        lake,
        "acme",
        "poly_city",
        export_dir,
        with_postcard=True,
    )
    assert (export_dir / "index.html").exists()
    assert (export_dir / "data" / "manifest.json").exists()
    assert (export_dir / "data" / "snapshots.parquet").exists()
    assert res.badge_path.exists()
    assert "CodeCity" in res.badge_path.read_text(encoding="utf-8")
    assert res.postcard_path is not None and res.postcard_path.exists()
    assert res.postcard_path.stat().st_size > 15_000

    # Also test FastAPI /badge.svg and /export endpoints
    app = create_app(lakehouse=lake, enable_quack=True)
    with TestClient(app) as client:
        badge = client.get("/api/repos/acme/poly_city/badge.svg")
        assert badge.status_code == 200
        assert "<svg" in badge.text

        exp = client.post(
            "/api/repos/acme/poly_city/export",
            json={"with_postcard": False},
        )
        assert exp.status_code == 200
        assert exp.json()["badge_url"] == "/api/repos/acme/poly_city/badge.svg"

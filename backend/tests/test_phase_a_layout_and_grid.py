"""Phase A tests: quantized urban parcel layout, pocket plazas, and street-grid endpoint."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from codecity.analyzer.layout import (
    CITY_CANVAS_D,
    CITY_CANVAS_W,
    compute_stable_city_layout,
    compute_urban_street_grid,
)
from codecity.analyzer.pipeline import analyze_repository
from codecity.api.app import create_app
from codecity.models import District, FileMetric, ZoneType
from codecity.storage.lakehouse import LakehouseManager
from tests.test_phase1_polyglot_analyzer import _create_polyglot_fixture_repo


def test_quantized_parcels_non_overlapping_and_within_district_bounds() -> None:
    weights = {
        f"core/mod_{i}.py": float(40 + (i * 75) % 600)
        for i in range(18)
    }
    weights.update({f"api/ep_{i}.py": float(30 + i * 50) for i in range(6)})
    weights.update({f"tests/test_{i}.py": 80.0 for i in range(5)})

    file_layout, district_layout = compute_stable_city_layout(weights)
    assert set(file_layout.keys()) == set(weights.keys())

    # Every lot fits inside city canvas and does not overlap other lots in the same district
    lots = list(file_layout.items())
    for fpath, (x, z, w, d) in lots:
        assert 0.0 <= x < CITY_CANVAS_W
        assert 0.0 <= z < CITY_CANVAS_D
        assert w > 0.5 and d > 0.5
        # Quantized urban aspect ratio stays reasonable (no hairline slivers)
        assert max(w / d, d / w) <= 4.5, f"{fpath} has extreme aspect: {w}x{d}"

    for i, (pa, ra) in enumerate(lots):
        ax, az, aw, ad = ra
        for pb, rb in lots[i + 1 :]:
            bx, bz, bw, bd = rb
            overlap_x = min(ax + aw, bx + bw) - max(ax, bx)
            overlap_z = min(az + ad, bz + bd) - max(az, bz)
            assert overlap_x <= 0.01 or overlap_z <= 0.01, f"Overlap between {pa} and {pb}"

    districts = [
        District(
            snapshot_idx=0,
            district_path=dpath,
            display_name=dpath,
            zone_type=zt,
            bounds_x=dx,
            bounds_z=dz,
            bounds_w=dw,
            bounds_d=dd,
            file_count=1,
        )
        for dpath, (dx, dz, dw, dd, zt) in district_layout.items()
    ]
    files = [
        FileMetric(
            snapshot_idx=0,
            file_path=fpath,
            district_path=fpath.split("/")[0],
            language="python",
            zone_type=ZoneType.DOWNTOWN_CORE,
            building_archetype="office_tower",
            layout_x=x,
            layout_z=z,
            layout_w=w,
            layout_d=d,
        )
        for fpath, (x, z, w, d) in file_layout.items()
    ]
    grid = compute_urban_street_grid(districts, files)
    assert len(grid.nodes) >= 4
    assert len(grid.segments) >= 4
    assert any(n.kind == "harbor_gate" for n in grid.nodes)


def test_city_grid_api_endpoint(tmp_path: Path) -> None:
    repo_dir = tmp_path / "poly-city"
    _create_polyglot_fixture_repo(repo_dir)
    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    summary = analyze_repository(
        str(repo_dir),
        lakehouse=lake,
        owner="acme",
        repo="poly-city",
        max_keyframes=4,
        workers=2,
    )
    app = create_app(lakehouse=lake, enable_quack=False)
    with TestClient(app) as client:
        resp = client.get(
            "/api/repos/acme/poly_city/city-grid",
            params={"snapshot_idx": summary.repo.latest_snapshot_idx},
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload["nodes"]) >= 4
        assert len(payload["segments"]) >= 4
        assert len(payload["x_lines"]) >= 2
        assert len(payload["z_lines"]) >= 2

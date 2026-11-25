"""Polyglot analyzer, quantized parcel layout, semantic enrichment & DuckLake write tests."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from codecity.analyzer.git_history import resolve_git_repo, select_keyframes
from codecity.analyzer.layout import CITY_CANVAS_D, CITY_CANVAS_W, compute_stable_city_layout
from codecity.analyzer.pipeline import analyze_repository
from codecity.analyzer.plugins.base import bun_supports_native_lint, safe_js_lint_prefix
from codecity.analyzer.plugins.typescript import TypeScriptPlugin
from codecity.analyzer.treesitter_core import scan_worktree_ast
from codecity.models import BuildingArchetype, ZoneType
from codecity.storage.lakehouse import LakehouseManager
from tests.conftest import create_polyglot_fixture_repo


def test_polyglot_pipeline_analyzes_all_four_languages_and_writes_ducklake(tmp_path: Path) -> None:
    repo_dir = create_polyglot_fixture_repo(tmp_path / "poly-city")

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    summary = analyze_repository(
        str(repo_dir),
        lakehouse=lake,
        owner="acme",
        repo="poly-city",
        max_keyframes=6,
        workers=2,
        semantic=True,
    )

    assert summary.snapshots_written == 3
    assert summary.repo.owner == "acme"
    assert summary.repo.repo == "poly_city"

    with lake.session(read_only=True) as con:
        pfx = lake.schema_prefix("acme", "poly_city")

        snaps = con.execute(
            f"SELECT snapshot_idx, git_tag, total_files, to_json(language_breakdown)::VARCHAR "
            f"FROM {pfx}.snapshots ORDER BY snapshot_idx;"
        ).fetchall()
        assert len(snaps) == 3
        assert snaps[0][1] == "v0.1.0"
        assert snaps[-1][1] == "v0.2.0"

        latest_idx = snaps[-1][0]
        files = con.execute(
            f"SELECT file_path, language, zone_type, building_archetype, lint_issue_count, "
            f"format_drift, layout_x, layout_z, layout_w, layout_d "
            f"FROM {pfx}.file_metrics WHERE snapshot_idx = {latest_idx};"
        ).fetchall()
        by_path = {row[0]: row for row in files}

        assert {"python", "typescript", "go", "rust"}.issubset({row[1] for row in files})
        assert by_path["tests/test_engine.py"][2] == ZoneType.GREENBELT_PARKS.value
        assert by_path["tests/test_engine.py"][3] == BuildingArchetype.PARK_STADIUM.value
        assert by_path["web/src/components/Card.tsx"][3] == BuildingArchetype.GLASS_PAVILION.value
        assert by_path["db/store.py"][3] == BuildingArchetype.TWIN_SILOS.value
        assert by_path["api/routes.py"][4] >= 1
        assert by_path["web/src/components/Card.tsx"][5] is True

        snap0_route = con.execute(
            f"SELECT layout_x, layout_z, layout_w, layout_d FROM {pfx}.file_metrics "
            f"WHERE snapshot_idx = 0 AND file_path = 'api/routes.py';"
        ).fetchone()
        assert snap0_route == by_path["api/routes.py"][6:10]

        imports = set(
            con.execute(
                f"SELECT source_file, target_file FROM {pfx}.file_imports "
                f"WHERE snapshot_idx = {latest_idx};"
            ).fetchall()
        )
        assert ("api/routes.py", "core/engine.py") in imports
        assert ("core/engine.py", "db/store.py") in imports
        assert ("web/src/components/Card.tsx", "web/src/utils.ts") in imports
        assert ("cmd/server/main.go", "pkg/worker/run.go") in imports
        assert ("crates/src/lib.rs", "crates/src/parser.rs") in imports

        rust_diags = con.execute(
            f"SELECT rule_code FROM {pfx}.lint_diagnostics "
            f"WHERE snapshot_idx = {latest_idx} AND file_path = 'crates/src/parser.rs';"
        ).fetchall()
        assert any(r[0] == "RS001" for r in rust_diags)

        cochanges = con.execute(
            f"SELECT file_a, file_b, shared_commits FROM {pfx}.cochange_pairs "
            f"WHERE snapshot_idx = {latest_idx};"
        ).fetchall()
        assert any(
            {row[0], row[1]} == {"api/routes.py", "web/src/components/Card.tsx"} and row[2] >= 2
            for row in cochanges
        )

        ecosystems = {
            row[0]
            for row in con.execute(
                f"SELECT DISTINCT ecosystem FROM {pfx}.external_deps "
                f"WHERE snapshot_idx = {latest_idx};"
            ).fetchall()
        }
        assert ecosystems == {"python", "npm", "go", "rust"}

        api_blurb = con.execute(
            f"SELECT summary_blurb FROM {pfx}.districts "
            f"WHERE snapshot_idx = {latest_idx} AND district_path = 'api';"
        ).fetchone()
        assert api_blurb and "routes incoming HTTP requests" in api_blurb[0]


def test_quantized_parcels_non_overlapping_and_within_canvas() -> None:
    weights = {f"core/mod_{i}.py": float(40 + (i * 75) % 600) for i in range(18)}
    weights.update({f"api/ep_{i}.py": float(30 + i * 50) for i in range(6)})
    weights.update({f"tests/test_{i}.py": 80.0 for i in range(5)})

    file_layout, _ = compute_stable_city_layout(weights)
    assert set(file_layout.keys()) == set(weights.keys())

    lots = list(file_layout.items())
    for fpath, (x, z, w, d) in lots:
        assert 0.0 <= x < CITY_CANVAS_W
        assert 0.0 <= z < CITY_CANVAS_D
        assert w > 0.5 and d > 0.5
        assert max(w / d, d / w) <= 4.5, f"{fpath} has extreme aspect: {w}x{d}"

    for i, (pa, (ax, az, aw, ad)) in enumerate(lots):
        for pb, (bx, bz, bw, bd) in lots[i + 1 :]:
            overlap_x = min(ax + aw, bx + bw) - max(ax, bx)
            overlap_z = min(az + ad, bz + bd) - max(az, bz)
            assert overlap_x <= 0.01 or overlap_z <= 0.01, f"Overlap between {pa} and {pb}"


def test_worktree_scanner_skips_symlinks_and_remote_rejects_local_urls(tmp_path: Path) -> None:
    outside = tmp_path / "secret.py"
    outside.write_text("SECRET = 'leak'\n")
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / "ok.py").write_text("def ok() -> int:\n    return 1\n")
    (wt / "leak.py").symlink_to(outside)

    scanned = scan_worktree_ast(wt)
    assert list(scanned.keys()) == ["ok.py"]

    for url in (
        "http://127.0.0.1:8787/repo.git",
        "https://localhost/a/b.git",
        "http://169.254.169.254/x",
        "git@localhost:a/b.git",
        "git@127.0.0.1:a/b.git",
    ):
        with pytest.raises(ValueError):
            resolve_git_repo(url, tmp_path / "clones")

    commits = [(f"sha{i}", datetime(2026, 1, 1 + i, tzinfo=UTC), None) for i in range(4)]
    assert [k.commit_sha for k in select_keyframes(commits, max_keyframes=1)] == ["sha3"]

    ts_wt = tmp_path / "ts_wt"
    ts_wt.mkdir()
    (ts_wt / "package.json").write_text(
        '{"name":"evil","scripts":{"lint":"bun -e '
        "\\\"require('fs').writeFileSync('pwn_pkg.txt','1')\\\"\"}}\n"
    )
    (ts_wt / "bunfig.toml").write_text(
        'preload = ["./evil_preload.js"]\n[fmt]\nsingleQuote = false\n'
    )
    (ts_wt / "evil_preload.js").write_text('require("fs").writeFileSync("pwn_preload.txt", "1");\n')
    (ts_wt / "oxlint.config.ts").write_text(
        'import fs from "node:fs"; fs.writeFileSync("pwn_oxlint.txt", "1"); export default {};\n'
    )
    (ts_wt / "index.ts").write_text("export const answer = 42;\n")

    ts_ast = scan_worktree_ast(ts_wt)
    TypeScriptPlugin().analyze(ts_wt, 0, ts_ast)
    assert not any(
        (ts_wt / pwn).exists() for pwn in ("pwn_pkg.txt", "pwn_preload.txt", "pwn_oxlint.txt")
    )

    fake_bun = tmp_path / "fake-bun"
    fake_bun.write_text("#!/usr/bin/env python3\nprint('--no-script --no-config')\n")
    fake_bun.chmod(0o755)
    assert bun_supports_native_lint(str(fake_bun)) is True
    with safe_js_lint_prefix(str(fake_bun)) as lint_spec:
        assert lint_spec is not None and lint_spec[0] == "bun-lint"
        assert "--no-script" in lint_spec[1] and "--no-config" in lint_spec[1]

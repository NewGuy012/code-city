"""Polyglot analyzer, quantized parcel layout, semantic enrichment & DuckLake write tests."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from codecity.analyzer import llm_summarizer
from codecity.analyzer.briefing import build_city_briefing
from codecity.analyzer.describer import build_file_description
from codecity.analyzer.git_history import resolve_git_repo, select_keyframes
from codecity.analyzer.layout import CITY_CANVAS_D, CITY_CANVAS_W, compute_stable_city_layout
from codecity.analyzer.pipeline import analyze_repository
from codecity.analyzer.plugins.go import GoPlugin
from codecity.analyzer.plugins.typescript import TypeScriptPlugin
from codecity.analyzer.semantic import RepoDocsContext
from codecity.analyzer.treesitter_core import analyze_file_ast, scan_worktree_ast
from codecity.models import BuildingArchetype, ExternalDep, ZoneType
from codecity.storage.lakehouse import LakehouseManager
from codecity.storage.llm_cache import LlmSummaryCache
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

        briefing_row = con.execute(
            f"SELECT to_json(city_briefing)::VARCHAR FROM {pfx}.snapshots "
            f"WHERE snapshot_idx = {latest_idx};"
        ).fetchone()
        assert briefing_row and briefing_row[0]
        briefing_json = json.loads(briefing_row[0])
        assert "Welcome" in briefing_json["mayor_welcome"]
        assert briefing_json["recommended_starts"]
        assert briefing_json["district_guides"]

        route_sig_row = con.execute(
            f"SELECT to_json(role_signals)::VARCHAR FROM {pfx}.file_metrics "
            f"WHERE snapshot_idx = {latest_idx} AND file_path = 'api/routes.py';"
        ).fetchone()
        assert route_sig_row and route_sig_row[0]
        route_desc = json.loads(route_sig_row[0])["description"]
        assert route_desc["short_summary"]
        assert any(sym["name"] == "handle_get" for sym in route_desc["key_symbols"])


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
        "https://nonexistent.invalid/repo.git",
        "git@-oProxyCommand=id:a/b.git",
    ):
        with pytest.raises(ValueError):
            resolve_git_repo(url, tmp_path / "clones")

    # Comment apostrophes must not mask subsequent route/hint detection
    ast_info = analyze_file_ast(
        "api/app.py",
        "# don't ignore\n@app.get('/items')\ndef items():\n    return []\n",
    )
    assert ast_info.signals["route_hints"] is True

    # Go import resolution enforces module path segment boundaries
    go_wt = tmp_path / "go_wt"
    (go_wt / "pkg").mkdir(parents=True)
    (go_wt / "go.mod").write_text("module example.com/app\n\ngo 1.24\n")
    (go_wt / "main.go").write_text(
        'package main\nimport "example.com/app-extra/pkg"\nfunc main(){}\n'
    )
    (go_wt / "pkg" / "p.go").write_text("package pkg\n")
    assert GoPlugin().analyze(go_wt, 0, scan_worktree_ast(go_wt)).imports == []

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
    (ts_wt / "eslint.config.js").write_text(
        'require("node:fs").writeFileSync("pwn_eslint.txt", "1"); module.exports = [];\n'
    )
    (ts_wt / "index.ts").write_text("debugger;\nexport const answer = 42;\n")

    ts_ast = scan_worktree_ast(ts_wt)
    ts_res = TypeScriptPlugin().analyze(ts_wt, 0, ts_ast)
    assert any(d.linter == "bun-lint" and "no-debugger" in d.rule_code for d in ts_res.diagnostics)
    assert not any(
        (ts_wt / pwn).exists()
        for pwn in ("pwn_pkg.txt", "pwn_preload.txt", "pwn_oxlint.txt", "pwn_eslint.txt")
    )


def test_ast_symbols_describer_and_llm_priority_chain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    py_info = analyze_file_ast(
        "api/items.py",
        '"""Manage item endpoints."""\n'
        "from fastapi import APIRouter\n"
        "@router.get('/items')\n"
        "def list_items():\n"
        '    """Fetch active items."""\n'
        "    return []\n",
    )
    assert py_info.module_doc == "Manage item endpoints."
    assert py_info.endpoints == ["GET /items"]
    assert py_info.symbols[0].name == "list_items"
    assert py_info.symbols[0].doc == "Fetch active items."

    tsx_info = analyze_file_ast(
        "web/Card.tsx",
        "/** Renders a summary card. */\n"
        "import React from 'react';\n"
        "export function Card() { return <div>Hi</div>; }\n"
        "export const useCardState = () => 1;\n",
    )
    assert "summary card" in tsx_info.module_doc
    assert [(s.name, s.kind) for s in tsx_info.symbols] == [
        ("Card", "component"),
        ("useCardState", "hook"),
    ]

    rs_info = analyze_file_ast(
        "crates/store.rs",
        "//! Storage module.\n"
        "pub struct RepoStore { count: usize }\n"
        "impl RepoStore {\n"
        "    pub fn save(&self) {}\n"
        "}\n",
    )
    assert rs_info.module_doc == "Storage module."
    assert rs_info.symbols[0].methods == ("save",)

    go_info = analyze_file_ast(
        "pkg/worker.go",
        "// Package worker handles jobs.\npackage worker\nfunc Run() int { return 1 }\n",
    )
    assert go_info.module_doc == "Package worker handles jobs."
    assert go_info.symbols[0].name == "Run" and go_info.symbols[0].exported is True

    desc = build_file_description(
        py_info,
        archetype=BuildingArchetype.GRAND_TERMINAL,
        zone=ZoneType.HARBOR_GATES,
        fan_in=2,
        fan_out=1,
        internal_targets=["core/db.py"],
        external_deps=[ExternalDep(snapshot_idx=0, ecosystem="python", package_name="fastapi")],
    )
    assert desc.external_packages == ["fastapi"]
    assert "GET /items" in desc.endpoints

    # Test LLM priority chain: 1) llama.cpp first -> 2) Gemini fallback -> 3) AST fallback
    cache = LlmSummaryCache(tmp_path / "llm_cache.sqlite")
    docs_ctx = RepoDocsContext(title="Demo", overview="Demo helps teammates.")
    calls: list[str] = []

    def fake_llama_ok(url, *, method="GET", payload=None, headers=None, timeout=10.0):
        calls.append(url)
        if url.endswith("/health"):
            return 200, {"status": "ok"}
        if url.endswith("/v1/models"):
            return 200, {"data": [{"id": "qwen2.5-coder"}]}
        if url.endswith("/v1/chat/completions"):
            return 200, {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "short_summary": "Handles item listing requests from users.",
                                    "detailed_overview": (
                                        "This API file routes incoming /items requests "
                                        "and returns item records for the UI."
                                    ),
                                    "responsibilities": ["Serves GET /items"],
                                }
                            )
                        }
                    }
                ]
            }
        raise AssertionError(f"Unexpected fallback call when llama.cpp succeeded: {url}")

    monkeypatch.setenv("CODECITY_LLM_PROVIDER", "auto")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(llm_summarizer, "_http_json", fake_llama_ok)
    llm_summarizer.reset_probe_cache()

    res_llama = llm_summarizer.enhance_building_description_with_llm(
        desc,
        file_path="api/items.py",
        source_text="def list_items(): return []\n",
        repo_name="acme/demo",
        docs_ctx=docs_ctx,
        repo_slug="acme/demo",
        cache=cache,
    )
    assert res_llama.source == "llamacpp"
    assert res_llama.model == "qwen2.5-coder"
    assert "Handles item listing" in res_llama.short_summary

    # Verify cache hit skips HTTP calls
    calls.clear()
    res_cached = llm_summarizer.enhance_building_description_with_llm(
        desc,
        file_path="api/items.py",
        source_text="def list_items(): return []\n",
        repo_name="acme/demo",
        docs_ctx=docs_ctx,
        repo_slug="acme/demo",
        cache=cache,
    )
    assert res_cached.source == "llamacpp"
    assert not any(c.endswith("/chat/completions") for c in calls)

    # When llama.cpp is unreachable, fall back to Gemini
    def fake_gemini_fallback(url, *, method="GET", payload=None, headers=None, timeout=10.0):
        calls.append(url)
        if "127.0.0.1:8080" in url:
            return 0, None
        if "generativelanguage.googleapis.com" in url:
            return 200, {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "short_summary": "Gemini plain-English module summary.",
                                            "detailed_overview": (
                                                "Explains how this module handles core logic."
                                            ),
                                            "responsibilities": ["Processes domain updates"],
                                        }
                                    )
                                }
                            ]
                        }
                    }
                ]
            }
        return 0, None

    monkeypatch.setattr(llm_summarizer, "_http_json", fake_gemini_fallback)
    llm_summarizer.reset_probe_cache()
    res_gemini = llm_summarizer.enhance_building_description_with_llm(
        desc,
        file_path="core/worker.py",
        source_text="def work(): return 42\n",
        repo_name="acme/demo",
        docs_ctx=docs_ctx,
        repo_slug="acme/demo",
        cache=cache,
    )
    assert res_gemini.source == "gemini"
    assert "Gemini plain-English" in res_gemini.short_summary

    # Sensitive files never get sent to cloud Gemini
    calls.clear()
    res_secret = llm_summarizer.enhance_building_description_with_llm(
        desc,
        file_path=".env.production",
        source_text="API_KEY=supersecret\n",
        repo_name="acme/demo",
        docs_ctx=docs_ctx,
        repo_slug="acme/demo",
        cache=cache,
    )
    assert res_secret.source == desc.source
    assert not any("generativelanguage.googleapis.com" in c for c in calls)

    # Briefing synthesis smoke check
    briefing = build_city_briefing("acme/demo", docs_ctx, [], [], [])
    assert "Demo" in briefing.mayor_welcome

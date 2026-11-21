"""Phase 1 tests: polyglot Git history, Tree-sitter, LanguagePlugins, Zoning, Layout & DuckLake."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from codecity.analyzer.pipeline import analyze_repository
from codecity.models import BuildingArchetype, ZoneType
from codecity.storage.lakehouse import LakehouseManager


def _git(
    repo: Path,
    args: list[str],
    *,
    author: str = "dev1@example.com",
    date: str = "2026-06-01T12:00:00Z",
) -> None:
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": author.split("@", 1)[0],
            "GIT_AUTHOR_EMAIL": author,
            "GIT_COMMITTER_NAME": author.split("@", 1)[0],
            "GIT_COMMITTER_EMAIL": author,
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_DATE": date,
        }
    )
    subprocess.run(
        ["git", "-C", str(repo), *args], env=env, check=True, capture_output=True, text=True
    )


def _create_polyglot_fixture_repo(repo_dir: Path) -> None:
    repo_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(repo_dir)], check=True)

    # Commit 1: Initial polyglot skeleton (Python + TS + Go + Rust + tests + lockfiles)
    (repo_dir / "pyproject.toml").write_text(
        '[project]\nname = "poly-city"\nversion = "0.1.0"\n'
        'dependencies = ["fastapi>=0.115.0", "duckdb>=2.0.0"]\n'
    )
    (repo_dir / "package.json").write_text(
        '{"name": "poly-ui", "dependencies": {"react": "19.3.1"}, '
        '"devDependencies": {"oxlint": "^1.0.0"}}\n'
    )
    (repo_dir / "bun.lock").write_text(
        '{\n  "lockfileVersion": 2,\n  "packages": {\n'
        '    "react": ["react@19.3.1", "", {}, "sha512-x"],\n  }\n}\n'
    )
    (repo_dir / "tsconfig.json").write_text(
        '{"compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["web/src/*"]}}}\n'
    )
    (repo_dir / "go.mod").write_text(
        "module example.com/polycity\n\ngo 1.24\n\nrequire github.com/spf13/cobra v1.9.1\n"
    )
    (repo_dir / "Cargo.toml").write_text(
        '[package]\nname = "poly_engine"\nversion = "0.1.0"\n[dependencies]\nserde = "1.0"\n'
    )

    (repo_dir / "api").mkdir()
    (repo_dir / "api" / "routes.py").write_text(
        "from core.engine import run_job\n\ndef handle_get():\n    return run_job()\n"
    )
    (repo_dir / "core").mkdir()
    (repo_dir / "core" / "__init__.py").write_text("")
    (repo_dir / "core" / "engine.py").write_text(
        "from db.store import save_row\n\n"
        "def run_job() -> dict[str, int]:\n"
        "    return save_row(1)\n"
    )
    (repo_dir / "db").mkdir()
    (repo_dir / "db" / "__init__.py").write_text("")
    (repo_dir / "db" / "store.py").write_text(
        "def save_row(val: int) -> dict[str, int]:\n"
        "    # SELECT * FROM items\n"
        "    return {'id': val}\n"
    )
    (repo_dir / "web" / "src" / "components").mkdir(parents=True)
    (repo_dir / "web" / "src" / "utils.ts").write_text(
        "export function formatTitle(name: string): string {\n  return name.trim();\n}\n"
    )
    (repo_dir / "web" / "src" / "components" / "Card.tsx").write_text(
        'import { formatTitle } from "@/utils";\n\n'
        "export function Card() {\n  return <div>{formatTitle('City')}</div>;\n}\n"
    )
    (repo_dir / "cmd" / "server").mkdir(parents=True)
    (repo_dir / "cmd" / "server" / "main.go").write_text(
        'package main\n\nimport "example.com/polycity/pkg/worker"\n\n'
        "func main() {\n\tworker.Run()\n}\n"
    )
    (repo_dir / "pkg" / "worker").mkdir(parents=True)
    (repo_dir / "pkg" / "worker" / "run.go").write_text(
        "package worker\n\nfunc Run() int {\n\tfor i := 0; i < 3; i++ {}\n\treturn 1\n}\n"
    )
    (repo_dir / "crates" / "src").mkdir(parents=True)
    (repo_dir / "crates" / "src" / "lib.rs").write_text(
        "mod parser;\npub fn boot() -> i32 { parser::parse() }\n"
    )
    (repo_dir / "crates" / "src" / "parser.rs").write_text(
        "pub fn parse() -> i32 {\n    let x = Some(42);\n    x.unwrap()\n}\n"
    )
    (repo_dir / "tests").mkdir()
    (repo_dir / "tests" / "test_engine.py").write_text(
        "from core.engine import run_job\n\ndef test_run():\n    assert run_job()['id'] == 1\n"
    )

    _git(repo_dir, ["add", "."], date="2026-05-01T10:00:00Z")
    _git(repo_dir, ["commit", "-m", "feat: initial polyglot city"], date="2026-05-01T10:00:00Z")
    _git(repo_dir, ["tag", "v0.1.0"], date="2026-05-01T10:00:00Z")

    # Commit 2 & 3: Co-change coupling between api/routes.py and Card.tsx + lint & format drift
    for idx, msg in enumerate(["fix: align card and route", "fix: hotfix route schema"], start=2):
        (repo_dir / "api" / "routes.py").write_text(
            "import os\nfrom core.engine import run_job\n\n"
            f"def handle_get():\n    # iter {idx}\n    return run_job()\n"
        )
        # Deliberately unformatted + debugger statement to verify bun fmt --check & oxlint
        (repo_dir / "web" / "src" / "components" / "Card.tsx").write_text(
            'import { formatTitle } from "@/utils";\n'
            f"export function Card() {{ debugger; const v={idx}; "
            f"return <div>{{formatTitle('City' + v)}}</div>; }}\n"
        )
        day = f"2026-06-{10 + idx:02d}T12:00:00Z"
        _git(repo_dir, ["add", "."], author="alice@example.com", date=day)
        _git(repo_dir, ["commit", "-m", msg], author="alice@example.com", date=day)

    _git(repo_dir, ["tag", "v0.2.0"], author="alice@example.com", date="2026-06-15T12:00:00Z")


def test_polyglot_pipeline_analyzes_all_four_languages_and_writes_ducklake(tmp_path: Path) -> None:
    repo_dir = tmp_path / "poly-city"
    _create_polyglot_fixture_repo(repo_dir)

    lake = LakehouseManager(data_dir=tmp_path / "lake_data")
    summary = analyze_repository(
        str(repo_dir),
        lakehouse=lake,
        owner="acme",
        repo="poly-city",
        max_keyframes=6,
        workers=2,
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

        # Verify all 4 primary languages detected
        langs = {row[1] for row in files}
        assert {"python", "typescript", "go", "rust"}.issubset(langs)

        # Verify SimCity zoning & archetypes
        assert by_path["tests/test_engine.py"][2] == ZoneType.GREENBELT_PARKS.value
        assert by_path["tests/test_engine.py"][3] == BuildingArchetype.PARK_STADIUM.value
        assert by_path["web/src/components/Card.tsx"][3] == BuildingArchetype.GLASS_PAVILION.value
        assert by_path["db/store.py"][3] == BuildingArchetype.TWIN_SILOS.value

        # Verify ruff unused import lint in api/routes.py and format drift/oxlint in Card.tsx
        assert by_path["api/routes.py"][4] >= 1
        assert by_path["web/src/components/Card.tsx"][5] is True

        # Verify stable layout across snapshots (routes.py plot unchanged between snap 0 and latest)
        snap0_route = con.execute(
            f"SELECT layout_x, layout_z, layout_w, layout_d FROM {pfx}.file_metrics "
            f"WHERE snapshot_idx = 0 AND file_path = 'api/routes.py';"
        ).fetchone()
        assert snap0_route == by_path["api/routes.py"][6:10]

        # Verify polyglot imports across Python, TS (@/ alias), Go (module prefix), Rust (mod)
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

        # Verify Rust RS001 diagnostic caught unchecked `.unwrap()`
        rust_diags = con.execute(
            f"SELECT rule_code FROM {pfx}.lint_diagnostics "
            f"WHERE snapshot_idx = {latest_idx} AND file_path = 'crates/src/parser.rs';"
        ).fetchall()
        assert any(r[0] == "RS001" for r in rust_diags)

        # Verify temporal co-change fault line between api/routes.py and Card.tsx
        cochanges = con.execute(
            f"SELECT file_a, file_b, shared_commits FROM {pfx}.cochange_pairs "
            f"WHERE snapshot_idx = {latest_idx};"
        ).fetchall()
        assert any(
            {row[0], row[1]} == {"api/routes.py", "web/src/components/Card.tsx"} and row[2] >= 2
            for row in cochanges
        )

        # Verify Supply Docks parsed all 4 ecosystems (python, npm, go, rust)
        ecosystems = {
            row[0]
            for row in con.execute(
                f"SELECT DISTINCT ecosystem FROM {pfx}.external_deps "
                f"WHERE snapshot_idx = {latest_idx};"
            ).fetchall()
        }
        assert ecosystems == {"python", "npm", "go", "rust"}

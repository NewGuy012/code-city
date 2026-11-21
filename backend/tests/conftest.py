"""Shared fixtures for CodeCity backend tests."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from codecity.analyzer.git_history import run_git


def git_commit(
    repo: Path,
    args: list[str],
    *,
    author: str = "dev1@example.com",
    date: str = "2026-06-01T12:00:00Z",
) -> None:
    name = author.split("@", 1)[0]
    run_git(
        repo,
        args,
        extra_env={
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": author,
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": author,
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_DATE": date,
        },
    )


def create_polyglot_fixture_repo(repo_dir: Path) -> Path:
    """Create a synthetic multi-commit Python/TS/Go/Rust repository for tests."""
    repo_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(repo_dir)], env=os.environ.copy(), check=True)

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
    (repo_dir / "README.md").write_text(
        "# Poly City\n\n"
        "The `api` district routes incoming HTTP requests and coordinates core workflows.\n"
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

    git_commit(repo_dir, ["add", "."], date="2026-05-01T10:00:00Z")
    git_commit(
        repo_dir, ["commit", "-m", "feat: initial polyglot city"], date="2026-05-01T10:00:00Z"
    )
    git_commit(repo_dir, ["tag", "v0.1.0"], date="2026-05-01T10:00:00Z")

    for idx, msg in enumerate(["fix: align card and route", "fix: hotfix route schema"], start=2):
        (repo_dir / "api" / "routes.py").write_text(
            "import os\nfrom core.engine import run_job\n\n"
            f"def handle_get():\n    # iter {idx}\n    return run_job()\n"
        )
        (repo_dir / "web" / "src" / "components" / "Card.tsx").write_text(
            'import { formatTitle } from "@/utils";\n'
            f"export function Card() {{ debugger; const v={idx}; "
            f"return <div>{{formatTitle('City' + v)}}</div>; }}\n"
        )
        day = f"2026-06-{10 + idx:02d}T12:00:00Z"
        git_commit(repo_dir, ["add", "."], author="alice@example.com", date=day)
        git_commit(repo_dir, ["commit", "-m", msg], author="alice@example.com", date=day)

    git_commit(repo_dir, ["tag", "v0.2.0"], author="alice@example.com", date="2026-06-15T12:00:00Z")
    return repo_dir

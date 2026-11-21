"""Safe Live Mayor Git-branch execution (`codecity/mayor-session`) and 90-day author stats."""

from __future__ import annotations

import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

from codecity.analyzer.plugins.base import (
    TS_EXTS,
    find_bun,
    find_local_oxlint,
    ruff_cmd,
    safe_repo_target,
)

MAYOR_BRANCH = "codecity/mayor-session"


def _run_git(
    repo_path: Path, args: list[str], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.setdefault("GIT_AUTHOR_NAME", "CodeCity Mayor")
    env.setdefault("GIT_AUTHOR_EMAIL", "mayor@codecity.local")
    env.setdefault("GIT_COMMITTER_NAME", "CodeCity Mayor")
    env.setdefault("GIT_COMMITTER_EMAIL", "mayor@codecity.local")
    return subprocess.run(
        ["git", "-C", str(repo_path), *args],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


def _current_branch(repo_path: Path) -> str:
    proc = _run_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    return proc.stdout.strip()


def ensure_mayor_branch(repo_path: Path) -> dict[str, Any]:
    """Ensure the repository is safely positioned on `codecity/mayor-session`."""
    cur = _current_branch(repo_path)
    if cur != MAYOR_BRANCH:
        # Check if working tree has uncommitted user modifications before switching
        status_proc = _run_git(repo_path, ["status", "--porcelain"])
        if status_proc.stdout.strip():
            raise ValueError(
                f"Working tree on `{cur}` has uncommitted changes. "
                "Commit or stash before starting Live Mayor Mode."
            )
        exists = (
            _run_git(
                repo_path,
                ["show-ref", "--verify", "--quiet", f"refs/heads/{MAYOR_BRANCH}"],
                check=False,
            ).returncode
            == 0
        )
        if exists:
            _run_git(repo_path, ["checkout", MAYOR_BRANCH])
        else:
            _run_git(repo_path, ["checkout", "-b", MAYOR_BRANCH])

    log_proc = _run_git(repo_path, ["log", "-n", "5", "--oneline"], check=False)
    return {
        "branch": MAYOR_BRANCH,
        "previous_branch": cur,
        "commits": [ln for ln in log_proc.stdout.splitlines() if ln.strip()],
    }


def get_mayor_status(repo_path: Path) -> dict[str, Any]:
    cur = _current_branch(repo_path)
    diff_stat = _run_git(repo_path, ["status", "--short"], check=False).stdout.strip()
    log_proc = _run_git(repo_path, ["log", "-n", "8", "--oneline"], check=False)
    return {
        "branch": cur,
        "is_mayor_branch": cur == MAYOR_BRANCH,
        "status_short": diff_stat,
        "recent_commits": [ln for ln in log_proc.stdout.splitlines() if ln.strip()],
    }


def list_repo_authors_90d(repo_path: Path) -> list[dict[str, Any]]:
    """Aggregate 90-day Git authors and files where each was the sole contributor."""
    proc = _run_git(
        repo_path,
        ["log", "--since=90 days ago", "--name-only", "--format=__AUTHOR__%an <%ae>"],
        check=False,
    )
    if not proc.stdout.strip():
        # Fallback to full log if repo commits are older than 90 days
        proc = _run_git(
            repo_path,
            ["log", "-n", "200", "--name-only", "--format=__AUTHOR__%an <%ae>"],
            check=False,
        )

    file_authors: dict[str, set[str]] = defaultdict(set)
    author_files: dict[str, set[str]] = defaultdict(set)
    cur_author = ""
    for line in proc.stdout.splitlines():
        if line.startswith("__AUTHOR__"):
            cur_author = line.removeprefix("__AUTHOR__").strip()
        elif line.strip() and cur_author:
            fpath = line.strip()
            file_authors[fpath].add(cur_author)
            author_files[cur_author].add(fpath)

    results = []
    for author, touched in author_files.items():
        sole = sorted(f for f in touched if len(file_authors[f]) == 1)
        results.append(
            {
                "author": author,
                "sole_files": sole,
                "total_files": len(touched),
            }
        )
    results.sort(key=lambda r: (-len(r["sole_files"]), -r["total_files"], r["author"]))
    return results


def _commit_if_dirty(
    repo_path: Path, paths: list[str], message: str
) -> tuple[bool, str | None, str]:
    diff_proc = _run_git(repo_path, ["diff", "--", *paths], check=False)
    status_proc = _run_git(repo_path, ["status", "--porcelain", "--", *paths], check=False)
    if not status_proc.stdout.strip():
        return False, None, ""
    _run_git(repo_path, ["add", "--", *paths])
    diff_cached = _run_git(repo_path, ["diff", "--cached", "--", *paths], check=False).stdout
    _run_git(
        repo_path,
        [
            "-c",
            "user.name=CodeCity Mayor",
            "-c",
            "user.email=mayor@codecity.local",
            "commit",
            "-m",
            message,
        ],
    )
    sha = _run_git(repo_path, ["rev-parse", "--short", "HEAD"]).stdout.strip()
    return True, sha, diff_cached or diff_proc.stdout


def execute_live_mayor_tool(
    repo_path: Path,
    *,
    tool: str,
    target_path: str,
    secondary_path: str | None = None,
    district_path: str = "",
    fan_in: int = 0,
    confirm: bool = False,
) -> dict[str, Any]:
    """Execute a Mayor tool safely on the `codecity/mayor-session` branch."""
    ensure_mayor_branch(repo_path)
    target = safe_repo_target(repo_path, target_path)

    if tool == "sweeper":
        if not target.exists():
            raise FileNotFoundError(f"Target file not found: {target_path}")
        if target_path.endswith((".py", ".pyi")):
            ruff = ruff_cmd()
            subprocess.run(
                [*ruff, "check", "--no-cache", "--fix", "--", target_path],
                cwd=repo_path,
                capture_output=True,
                timeout=15,
            )
            subprocess.run(
                [*ruff, "format", "--no-cache", "--", target_path],
                cwd=repo_path,
                capture_output=True,
                timeout=15,
            )
        elif target_path.endswith(TS_EXTS):
            oxlint_bin = find_local_oxlint()
            bun_bin = find_bun()
            if bun_bin and oxlint_bin:
                subprocess.run(
                    [bun_bin, "run", oxlint_bin, "--fix", "--", str(target)],
                    cwd=repo_path,
                    capture_output=True,
                    timeout=15,
                )
            if bun_bin:
                subprocess.run(
                    [bun_bin, "fmt", "--no-script", "--", str(target)],
                    cwd=repo_path,
                    capture_output=True,
                    timeout=15,
                )
        committed, sha, diff = _commit_if_dirty(
            repo_path,
            [target_path],
            f"style(mayor): sweep lints and formatting in {target_path}",
        )
        return {
            "ok": True,
            "branch": MAYOR_BRANCH,
            "tool": tool,
            "target_path": target_path,
            "committed": committed,
            "commit_sha": sha,
            "diff": diff,
            "message": f"Swept {target_path} on {MAYOR_BRANCH}"
            if committed
            else f"{target_path} already clean.",
        }

    if tool == "proving_park":
        stem = re.sub(r"[^a-zA-Z0-9_]+", "_", Path(target_path).stem).strip("_") or "module"
        if target_path.endswith((".ts", ".tsx", ".js", ".jsx")):
            rel_test = f"{Path(target_path).parent.as_posix()}/{stem}.mayor.test.ts".removeprefix(
                "./"
            )
            test_file = safe_repo_target(repo_path, rel_test)
            test_file.parent.mkdir(parents=True, exist_ok=True)
            if not test_file.exists():
                test_file.write_text(
                    'import { describe, expect, test } from "bun:test";\n\n'
                    f'describe("{target_path}", () => {{\n'
                    '  test("scaffolded proving park test", () => {\n'
                    "    expect(true).toBe(true);\n"
                    "  });\n"
                    "});\n",
                    encoding="utf-8",
                )
        else:
            rel_test = f"tests/test_{stem}_mayor.py"
            test_file = safe_repo_target(repo_path, rel_test)
            test_file.parent.mkdir(parents=True, exist_ok=True)
            if not test_file.exists():
                test_file.write_text(
                    f'"""Proving Park starter tests for `{target_path}`."""\n\n'
                    f"def test_{stem}_proving_park_smoke() -> None:\n"
                    "    assert True\n",
                    encoding="utf-8",
                )
        committed, sha, diff = _commit_if_dirty(
            repo_path,
            [rel_test],
            f"test(mayor): plant Proving Park {rel_test}",
        )
        return {
            "ok": True,
            "branch": MAYOR_BRANCH,
            "tool": tool,
            "target_path": rel_test,
            "committed": committed,
            "commit_sha": sha,
            "diff": diff,
            "message": f"Scaffolded starter test `{rel_test}` on {MAYOR_BRANCH}",
        }

    if tool == "co_maintainer":
        owners_rel = ".github/CODEOWNERS"
        owners_file = safe_repo_target(repo_path, owners_rel)
        owners_file.parent.mkdir(parents=True, exist_ok=True)
        existing = owners_file.read_text(encoding="utf-8") if owners_file.exists() else ""
        entry = f"/{target_path} @core-maintainers @co-maintainer"
        if entry not in existing:
            new_text = (existing.rstrip() + "\n" + entry + "\n").lstrip("\n")
            owners_file.write_text(new_text, encoding="utf-8")
        committed, sha, diff = _commit_if_dirty(
            repo_path,
            [owners_rel],
            f"chore(mayor): assign co-maintainer for {target_path}",
        )
        return {
            "ok": True,
            "branch": MAYOR_BRANCH,
            "tool": tool,
            "target_path": owners_rel,
            "committed": committed,
            "commit_sha": sha,
            "diff": diff,
            "message": f"Updated {owners_rel} for {target_path} on {MAYOR_BRANCH}",
        }

    if tool in {"splitter", "transit_hub"}:
        slug = re.sub(r"[^a-zA-Z0-9_]+", "_", target_path).strip("_")
        spec_rel = f".codecity/blueprints/{tool}_{slug}.md"
        spec_file = safe_repo_target(repo_path, spec_rel)
        spec_file.parent.mkdir(parents=True, exist_ok=True)
        body = (
            f"# Mayor Live Spec ({tool}): `{target_path}`\n\n"
            f"- District: `{district_path or Path(target_path).parent.as_posix()}`\n"
            + (f"- Coupled Partner: `{secondary_path}`\n" if secondary_path else "")
            + "\n## Recommended Refactor Checklist\n"
            + (
                "- [ ] Extract cohesive domain submodules (`_core`, `_service`, `_adapter`)\n"
                "- [ ] Preserve re-exports for zero-breakage callers\n"
                if tool == "splitter"
                else "- [ ] Introduce interface/protocol adapter breaking direct cycle\n"
                "- [ ] Route imports cleanly through interface hub\n"
            )
        )
        spec_file.write_text(body, encoding="utf-8")
        committed, sha, diff = _commit_if_dirty(
            repo_path,
            [spec_rel],
            f"docs(mayor): emit {tool} refactor blueprint for {target_path}",
        )
        return {
            "ok": True,
            "branch": MAYOR_BRANCH,
            "tool": tool,
            "target_path": spec_rel,
            "committed": committed,
            "commit_sha": sha,
            "diff": diff,
            "message": f"Generated refactor spec `{spec_rel}` on {MAYOR_BRANCH}",
        }

    if tool == "bulldozer":
        if fan_in > 0:
            raise ValueError(f"Refusing live git rm: `{target_path}` still has fan_in={fan_in}.")
        if not confirm:
            raise ValueError("Live Bulldozer requires explicit confirmation (`confirm=true`).")
        if not target.exists():
            raise FileNotFoundError(f"Target file not found: {target_path}")
        _run_git(repo_path, ["rm", "--", target_path])
        _run_git(
            repo_path,
            [
                "-c",
                "user.name=CodeCity Mayor",
                "-c",
                "user.email=mayor@codecity.local",
                "commit",
                "-m",
                f"chore(mayor): remove dead module {target_path}",
            ],
        )
        sha = _run_git(repo_path, ["rev-parse", "--short", "HEAD"]).stdout.strip()
        return {
            "ok": True,
            "branch": MAYOR_BRANCH,
            "tool": tool,
            "target_path": target_path,
            "committed": True,
            "commit_sha": sha,
            "diff": f"--- a/{target_path}\n+++ /dev/null\n",
            "message": f"Removed `{target_path}` via git rm on {MAYOR_BRANCH}",
        }

    raise ValueError(f"Unsupported Mayor tool: {tool}")

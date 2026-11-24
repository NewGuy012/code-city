"""Safe Live Mayor Git-branch execution (`codecity/mayor-session`) and 90-day author stats."""

from __future__ import annotations

import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

from codecity.analyzer.git_history import run_git
from codecity.analyzer.plugins import apply_file_fix
from codecity.analyzer.plugins.base import TS_EXTS, safe_repo_target

MAYOR_BRANCH = "codecity/mayor-session"
_MAYOR_ENV = {
    "GIT_AUTHOR_NAME": "CodeCity Mayor",
    "GIT_AUTHOR_EMAIL": "mayor@codecity.local",
    "GIT_COMMITTER_NAME": "CodeCity Mayor",
    "GIT_COMMITTER_EMAIL": "mayor@codecity.local",
}


def _mayor_git(
    repo_path: Path, args: list[str], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return run_git(repo_path, args, check=check, extra_env=_MAYOR_ENV)


def _current_branch(repo_path: Path) -> str:
    return _mayor_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()


def ensure_mayor_branch(repo_path: Path) -> dict[str, Any]:
    """Ensure the repository is safely positioned on `codecity/mayor-session`."""
    cur = _current_branch(repo_path)
    if cur != MAYOR_BRANCH:
        if _mayor_git(repo_path, ["status", "--porcelain"]).stdout.strip():
            raise ValueError(
                f"Working tree on `{cur}` has uncommitted changes. "
                "Commit or stash before starting Live Mayor Mode."
            )
        exists = (
            _mayor_git(
                repo_path,
                ["show-ref", "--verify", "--quiet", f"refs/heads/{MAYOR_BRANCH}"],
                check=False,
            ).returncode
            == 0
        )
        _mayor_git(
            repo_path, ["checkout", MAYOR_BRANCH] if exists else ["checkout", "-b", MAYOR_BRANCH]
        )

    log_proc = _mayor_git(repo_path, ["log", "-n", "5", "--oneline"], check=False)
    return {
        "branch": MAYOR_BRANCH,
        "previous_branch": cur,
        "commits": [ln for ln in log_proc.stdout.splitlines() if ln.strip()],
    }


def list_repo_authors_90d(repo_path: Path) -> list[dict[str, Any]]:
    """Aggregate 90-day Git authors and files where each was the sole contributor."""
    proc = _mayor_git(
        repo_path,
        ["log", "--since=90 days ago", "--name-only", "--format=__AUTHOR__%an <%ae>"],
        check=False,
    )
    if not proc.stdout.strip():
        proc = _mayor_git(
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

    results = [
        {
            "author": author,
            "sole_files": sorted(f for f in touched if len(file_authors[f]) == 1),
            "total_files": len(touched),
        }
        for author, touched in author_files.items()
    ]
    results.sort(key=lambda r: (-len(r["sole_files"]), -r["total_files"], r["author"]))
    return results


def _commit_staged(repo_path: Path, paths: list[str], message: str) -> tuple[str, str]:
    diff_cached = _mayor_git(repo_path, ["diff", "--cached", "--", *paths], check=False).stdout
    _mayor_git(repo_path, ["commit", "-m", message])
    sha = _mayor_git(repo_path, ["rev-parse", "--short", "HEAD"]).stdout.strip()
    return sha, diff_cached


def _commit_if_dirty(
    repo_path: Path, paths: list[str], message: str
) -> tuple[bool, str | None, str]:
    if not _mayor_git(
        repo_path, ["status", "--porcelain", "--", *paths], check=False
    ).stdout.strip():
        return False, None, ""
    _mayor_git(repo_path, ["add", "--", *paths])
    sha, diff = _commit_staged(repo_path, paths, message)
    return True, sha, diff


def _tool_result(
    tool: str,
    target_path: str,
    committed: bool,
    sha: str | None,
    diff: str,
    message: str,
) -> dict[str, Any]:
    return {
        "ok": True,
        "branch": MAYOR_BRANCH,
        "tool": tool,
        "target_path": target_path,
        "committed": committed,
        "commit_sha": sha,
        "diff": diff,
        "message": message,
    }


def _write_and_commit(
    repo_path: Path,
    *,
    tool: str,
    rel_path: str,
    content: str,
    commit_msg: str,
    user_msg: str,
    only_if_missing: bool = False,
) -> dict[str, Any]:
    dest = safe_repo_target(repo_path, rel_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not (only_if_missing and dest.exists()):
        dest.write_text(content, encoding="utf-8")
    committed, sha, diff = _commit_if_dirty(repo_path, [rel_path], commit_msg)
    return _tool_result(tool, rel_path, committed, sha, diff, user_msg)


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
    rel_target = target.relative_to(repo_path.resolve()).as_posix()

    if tool == "sweeper":
        if not target.is_file():
            raise FileNotFoundError(f"Target file not found: {target_path}")
        apply_file_fix(repo_path, rel_target)
        committed, sha, diff = _commit_if_dirty(
            repo_path,
            [rel_target],
            f"style(mayor): sweep lints and formatting in {rel_target}",
        )
        msg = (
            f"Swept {rel_target} on {MAYOR_BRANCH}" if committed else f"{rel_target} already clean."
        )
        return _tool_result(tool, rel_target, committed, sha, diff, msg)

    if tool == "proving_park":
        stem = re.sub(r"[^a-zA-Z0-9_]+", "_", Path(rel_target).stem).strip("_") or "module"
        if rel_target.endswith(TS_EXTS):
            parent_dir = Path(rel_target).parent.as_posix()
            rel_test = (
                f"{stem}.mayor.test.ts"
                if parent_dir == "."
                else f"{parent_dir}/{stem}.mayor.test.ts"
            )
            content = (
                'import { describe, expect, test } from "bun:test";\n\n'
                f"describe({json.dumps(rel_target)}, () => {{\n"
                '  test("scaffolded proving park test", () => {\n'
                "    expect(true).toBe(true);\n"
                "  });\n"
                "});\n"
            )
        else:
            rel_test = f"tests/test_{stem}_mayor.py"
            content = (
                '"""Proving Park starter tests."""\n\n'
                f"TARGET = {json.dumps(rel_target)}\n\n"
                f"def test_{stem}_proving_park_smoke() -> None:\n"
                "    assert TARGET\n"
            )
        return _write_and_commit(
            repo_path,
            tool=tool,
            rel_path=rel_test,
            content=content,
            commit_msg=f"test(mayor): plant Proving Park {rel_test}",
            user_msg=f"Scaffolded starter test `{rel_test}` on {MAYOR_BRANCH}",
            only_if_missing=True,
        )

    if tool == "co_maintainer":
        if any(ch.isspace() for ch in rel_target):
            raise ValueError("Target path cannot contain whitespace for CODEOWNERS entry")
        owners_rel = ".github/CODEOWNERS"
        owners_file = safe_repo_target(repo_path, owners_rel)
        existing = owners_file.read_text(encoding="utf-8") if owners_file.exists() else ""
        entry = f"/{rel_target} @core-maintainers @co-maintainer"
        content = (
            existing
            if entry in existing.splitlines()
            else (existing.rstrip() + "\n" + entry + "\n").lstrip("\n")
        )
        return _write_and_commit(
            repo_path,
            tool=tool,
            rel_path=owners_rel,
            content=content,
            commit_msg=f"chore(mayor): assign co-maintainer for {rel_target}",
            user_msg=f"Updated {owners_rel} for {rel_target} on {MAYOR_BRANCH}",
        )

    if tool in {"splitter", "transit_hub"}:
        slug = re.sub(r"[^a-zA-Z0-9_]+", "_", rel_target).strip("_")
        spec_rel = f".github/codecity-blueprints/{tool}_{slug}.md"
        checklist = (
            "- [ ] Extract cohesive domain submodules (`_core`, `_service`, `_adapter`)\n"
            "- [ ] Preserve re-exports for zero-breakage callers\n"
            if tool == "splitter"
            else "- [ ] Introduce interface/protocol adapter breaking direct cycle\n"
            "- [ ] Route imports cleanly through interface hub\n"
        )
        body = (
            f"# Mayor Live Spec ({tool}): `{rel_target}`\n\n"
            f"- District: `{district_path or Path(rel_target).parent.as_posix()}`\n"
            + (f"- Coupled Partner: `{secondary_path}`\n" if secondary_path else "")
            + "\n## Recommended Refactor Checklist\n"
            + checklist
        )
        return _write_and_commit(
            repo_path,
            tool=tool,
            rel_path=spec_rel,
            content=body,
            commit_msg=f"docs(mayor): emit {tool} refactor blueprint for {rel_target}",
            user_msg=f"Generated refactor spec `{spec_rel}` on {MAYOR_BRANCH}",
        )

    if tool == "bulldozer":
        if fan_in > 0:
            raise ValueError(f"Refusing live git rm: `{rel_target}` still has fan_in={fan_in}.")
        if not confirm:
            raise ValueError("Live Bulldozer requires explicit confirmation (`confirm=true`).")
        if not target.is_file():
            raise FileNotFoundError(f"Target file not found: {target_path}")
        _mayor_git(repo_path, ["rm", "--", rel_target])
        sha, _ = _commit_staged(
            repo_path,
            [rel_target],
            f"chore(mayor): remove dead module {rel_target}",
        )
        return _tool_result(
            tool,
            rel_target,
            True,
            sha,
            f"--- a/{rel_target}\n+++ /dev/null\n",
            f"Removed `{rel_target}` via git rm on {MAYOR_BRANCH}",
        )

    raise ValueError(f"Unsupported Mayor tool: {tool}")

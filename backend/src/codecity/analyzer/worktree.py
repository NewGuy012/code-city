"""Parallel ephemeral `git worktree` keyframe materialization and union file discovery."""

from __future__ import annotations

import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from codecity.analyzer.git_history import KeyframeSpec, run_git
from codecity.analyzer.treesitter_core import should_skip_path


def list_keyframe_file_sizes(repo_path: Path, keyframes: list[KeyframeSpec]) -> dict[str, float]:
    """Collect union file weights across keyframes via `git ls-tree -r -l`."""
    weights: dict[str, float] = {}
    for kf in keyframes:
        out = run_git(repo_path, ["ls-tree", "-r", "-l", kf.commit_sha]).stdout
        for line in out.splitlines():
            if "\t" not in line:
                continue
            meta, rel = line.split("\t", 1)
            rel_norm = rel.strip()
            if should_skip_path(rel_norm):
                continue
            parts = meta.split()
            size_bytes = int(parts[3]) if len(parts) >= 4 and parts[3].isdigit() else 400
            # Approximate SLOC weight (~35 bytes/line, clamped for treemap balance)
            est_weight = max(15.0, min(2000.0, size_bytes / 35.0))
            if est_weight > weights.get(rel_norm, 0.0):
                weights[rel_norm] = est_weight
    return weights


class WorktreeManager:
    """Thread-safe ephemeral `git worktree` checkout manager."""

    def __init__(self, repo_path: Path) -> None:
        self.repo_path = repo_path
        self._git_meta_lock = threading.Lock()

    @contextmanager
    def checkout(self, commit_sha: str) -> Iterator[Path]:
        """Materialize `commit_sha` in a temporary directory and clean it up on exit."""
        with tempfile.TemporaryDirectory(prefix="codecity_wt_") as tmp_dir:
            wt_path = Path(tmp_dir) / "wt"
            with self._git_meta_lock:
                run_git(
                    self.repo_path,
                    ["worktree", "add", "--detach", "--quiet", str(wt_path), commit_sha],
                )
            try:
                yield wt_path
            finally:
                with self._git_meta_lock:
                    run_git(
                        self.repo_path,
                        ["worktree", "remove", "--force", str(wt_path)],
                        check=False,
                    )
                    run_git(self.repo_path, ["worktree", "prune"], check=False)

"""Git history streaming, keyframe sampling, and rolling churn / bus-factor / co-change engine."""

from __future__ import annotations

import os
import re
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from codecity.models import CochangePair

BUGFIX_RE = re.compile(r"\b(fix|fixes|fixed|bug|hotfix|patch|crash|revert|error|issue)\b", re.I)
MAX_COCHANGE_FILES_PER_COMMIT = 35
ROLLING_WINDOW_DAYS = 90
_REMOTE_PREFIXES = ("http://", "https://", "git@", "ssh://")


@dataclass(frozen=True, slots=True)
class KeyframeSpec:
    """Selected historical commit snapshot to materialize and analyze."""

    snapshot_idx: int
    commit_sha: str
    committed_at: datetime
    git_tag: str | None = None


@dataclass(frozen=True, slots=True)
class FileHistoryStats:
    """Rolling 90-day Git activity metrics for a file at a keyframe."""

    churn_90d: int
    bugfix_commits_90d: int
    distinct_authors_90d: int


@dataclass(frozen=True, slots=True)
class GitTouch:
    """Single file touch parsed from `git log --numstat`."""

    commit_sha: str
    committed_at: datetime
    author_email: str
    is_bugfix: bool
    file_path: str
    lines_changed: int


@dataclass
class GitHistoryAnalysis:
    """Full Pass-1 Git history dataset computed across the repository."""

    keyframes: list[KeyframeSpec]
    touches: list[GitTouch]

    def stats_for_keyframe(self, keyframe: KeyframeSpec) -> dict[str, FileHistoryStats]:
        """Compute rolling 90-day churn, bug-fix count, and bus factor up to `keyframe`."""
        if not self.touches:
            return {}
        end_ts = keyframe.committed_at.astimezone(UTC).replace(tzinfo=None)
        start_ts = end_ts - timedelta(days=ROLLING_WINDOW_DAYS)

        acc: dict[str, list[Any]] = {}
        for t in self.touches:
            if not (start_ts <= t.committed_at <= end_ts):
                continue
            item = acc.get(t.file_path)
            if item is None:
                item = [set(), 0, 0, set()]
                acc[t.file_path] = item
            item[0].add(t.commit_sha)
            item[1] += t.lines_changed
            if t.is_bugfix:
                item[2] += 1
            item[3].add(t.author_email)

        stats: dict[str, FileHistoryStats] = {}
        for fpath, (commits, lines, bugfixes, authors) in acc.items():
            n_commits = len(commits)
            churn = n_commits + min(50, lines // 40)
            stats[fpath] = FileHistoryStats(
                churn_90d=max(n_commits, churn),
                bugfix_commits_90d=bugfixes,
                distinct_authors_90d=len(authors),
            )
        return stats

    def cochanges_for_keyframe(
        self,
        keyframe: KeyframeSpec,
        active_files: set[str],
        *,
        min_shared_commits: int = 2,
        min_coupling_ratio: float = 0.25,
        limit: int = 250,
    ) -> list[CochangePair]:
        """Compute hidden temporal co-change pairs up to `keyframe`."""
        if not self.touches or not active_files:
            return []

        end_ts = keyframe.committed_at.astimezone(UTC).replace(tzinfo=None)
        file_commit_counts: dict[str, int] = defaultdict(int)
        commit_files: dict[str, set[str]] = defaultdict(set)

        for t in self.touches:
            if t.committed_at <= end_ts and t.file_path in active_files:
                seen_in_commit = commit_files[t.commit_sha]
                if t.file_path not in seen_in_commit:
                    seen_in_commit.add(t.file_path)
                    file_commit_counts[t.file_path] += 1

        pair_counts: dict[tuple[str, str], int] = defaultdict(int)
        for files in commit_files.values():
            if len(files) < 2 or len(files) > MAX_COCHANGE_FILES_PER_COMMIT:
                continue
            uniq = sorted(files)
            for idx, a in enumerate(uniq):
                for b in uniq[idx + 1 :]:
                    pair_counts[(a, b)] += 1

        pairs: list[CochangePair] = []
        for (a, b), shared in pair_counts.items():
            if shared < min_shared_commits:
                continue
            denom = min(file_commit_counts[a], file_commit_counts[b])
            if denom <= 0:
                continue
            ratio = round(shared / denom, 3)
            if ratio < min_coupling_ratio:
                continue
            pairs.append(
                CochangePair(
                    snapshot_idx=keyframe.snapshot_idx,
                    file_a=a,
                    file_b=b,
                    shared_commits=shared,
                    coupling_ratio=ratio,
                )
            )

        pairs.sort(key=lambda p: (p.coupling_ratio, p.shared_commits), reverse=True)
        return pairs[:limit]


def run_git(
    repo_path: Path,
    args: list[str],
    *,
    check: bool = True,
    extra_env: dict[str, str] | None = None,
    timeout: int = 60,
) -> subprocess.CompletedProcess[str]:
    """Run a git subcommand inside `repo_path` with non-interactive prompt suppression."""
    env = os.environ.copy()
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["git", "-C", str(repo_path), *args],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
        timeout=timeout,
    )


def resolve_git_repo(source: str, clones_dir: Path) -> Path:
    """Resolve a local repository path or clone a remote public Git URL into `clones_dir`."""
    cleaned = source.strip()
    if not cleaned or any(ch in cleaned for ch in ("\x00", "\n", "\r")):
        raise ValueError("Invalid repository source path or URL")

    local_candidate = Path(cleaned).expanduser()
    if local_candidate.exists():
        resolved = local_candidate.resolve()
        top = run_git(resolved, ["rev-parse", "--show-toplevel"]).stdout.strip()
        return Path(top)

    if (
        cleaned.startswith(_REMOTE_PREFIXES)
        and not cleaned.startswith("-")
        and not any(ch.isspace() for ch in cleaned)
    ):
        clones_root = clones_dir.resolve()
        clones_root.mkdir(parents=True, exist_ok=True)
        slug = (
            re.sub(r"[^a-zA-Z0-9._-]+", "_", cleaned.rstrip("/").removesuffix(".git")).strip(".")
            or "repo"
        )
        dest = (clones_root / slug).resolve()
        if not dest.is_relative_to(clones_root) or dest == clones_root:
            raise ValueError(f"Unsafe clone destination for {source}")
        if (dest / ".git").exists():
            run_git(dest, ["fetch", "--tags", "--quiet"], check=False, timeout=120)
            return dest
        env = os.environ.copy()
        env.setdefault("GIT_TERMINAL_PROMPT", "0")
        subprocess.run(
            ["git", "clone", "--quiet", "--", cleaned, str(dest)],
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return dest

    raise FileNotFoundError(f"Git repository source not found: {source}")


def _list_tags_by_commit(repo_path: Path) -> dict[str, str]:
    proc = run_git(repo_path, ["show-ref", "--tags", "--dereference"], check=False)
    if proc.returncode != 0:
        return {}
    tags: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        sha, ref = parts[0], parts[1]
        name = ref.removeprefix("refs/tags/").removesuffix("^{}")
        # Prefer dereferenced tag SHA when both annotated and peeled entries appear
        if ref.endswith("^{}") or sha not in tags:
            tags[sha] = name
    return tags


def parse_git_history(
    repo_path: Path,
    *,
    max_keyframes: int = 16,
) -> GitHistoryAnalysis:
    """Stream `git log --numstat` and select evenly spaced + tagged keyframes."""
    raw = run_git(
        repo_path,
        [
            "log",
            "--reverse",
            "--no-renames",
            "--numstat",
            "--format=__CODECITY_COMMIT__%H%x00%aI%x00%ae%x00%s",
        ],
    ).stdout
    tags_by_sha = _list_tags_by_commit(repo_path)

    commits: list[tuple[str, datetime, str | None]] = []
    touches: list[GitTouch] = []

    cur_sha = ""
    cur_ts = datetime.now(UTC).replace(tzinfo=None)
    cur_author = ""
    cur_bugfix = False

    for line in raw.splitlines():
        if line.startswith("__CODECITY_COMMIT__"):
            parts = line.removeprefix("__CODECITY_COMMIT__").split("\x00", 3)
            if len(parts) < 4:
                continue
            cur_sha, ts_str, cur_author, subject = parts
            cur_ts = datetime.fromisoformat(ts_str).astimezone(UTC).replace(tzinfo=None)
            cur_bugfix = bool(BUGFIX_RE.search(subject))
            commits.append((cur_sha, cur_ts, tags_by_sha.get(cur_sha)))
            continue

        if not line.strip() or not cur_sha:
            continue
        fields = line.split("\t", 2)
        if len(fields) != 3:
            continue
        ins_s, del_s, fpath = fields
        ins = int(ins_s) if ins_s.isdigit() else 0
        dels = int(del_s) if del_s.isdigit() else 0
        touches.append(
            GitTouch(
                commit_sha=cur_sha,
                committed_at=cur_ts,
                author_email=cur_author,
                is_bugfix=cur_bugfix,
                file_path=fpath.strip(),
                lines_changed=ins + dels,
            )
        )

    return GitHistoryAnalysis(
        keyframes=select_keyframes(commits, max_keyframes=max_keyframes),
        touches=touches,
    )


def select_keyframes(
    commits_chronological: list[tuple[str, datetime, str | None]],
    *,
    max_keyframes: int = 16,
) -> list[KeyframeSpec]:
    """Sample chronological keyframes, preserving HEAD, initial commit, and tagged releases."""
    n = len(commits_chronological)
    if n == 0:
        return []
    if n <= max_keyframes:
        chosen_indices = list(range(n))
    else:
        chosen_set: set[int] = {0, n - 1}
        tagged_indices = [i for i, (_, _, tag) in enumerate(commits_chronological) if tag]
        if tagged_indices:
            tag_budget = max(1, max_keyframes // 2)
            if len(tagged_indices) <= tag_budget:
                chosen_set.update(tagged_indices)
            else:
                step = (len(tagged_indices) - 1) / max(1, tag_budget - 1)
                for j in range(tag_budget):
                    chosen_set.add(tagged_indices[round(j * step)])

        if len(chosen_set) < max_keyframes:
            step = (n - 1) / max(1, max_keyframes - 1)
            for j in range(max_keyframes):
                if len(chosen_set) >= max_keyframes:
                    break
                chosen_set.add(round(j * step))
        chosen_indices = sorted(chosen_set)[:max_keyframes]

    return [
        KeyframeSpec(
            snapshot_idx=snap_idx,
            commit_sha=sha,
            committed_at=dt.replace(tzinfo=UTC),
            git_tag=tag,
        )
        for snap_idx, ci in enumerate(chosen_indices)
        for sha, dt, tag in (commits_chronological[ci],)
    ]

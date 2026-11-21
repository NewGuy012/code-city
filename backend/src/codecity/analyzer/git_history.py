"""Git history streaming, keyframe sampling, and Polars churn / bus-factor / co-change engine."""

from __future__ import annotations

import re
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polars as pl

from codecity.models import CochangePair

BUGFIX_RE = re.compile(r"\b(fix|fixes|fixed|bug|hotfix|patch|crash|revert|error|issue)\b", re.I)
MAX_COCHANGE_FILES_PER_COMMIT = 35
ROLLING_WINDOW_DAYS = 90


@dataclass(frozen=True)
class KeyframeSpec:
    """Selected historical commit snapshot to materialize and analyze."""

    snapshot_idx: int
    commit_sha: str
    committed_at: datetime
    git_tag: str | None = None


@dataclass(frozen=True)
class FileHistoryStats:
    """Rolling 90-day Git activity metrics for a file at a specific keyframe."""

    churn_90d: int
    bugfix_commits_90d: int
    distinct_authors_90d: int


@dataclass
class GitHistoryAnalysis:
    """Full Pass-1 Git history dataset computed across the repository."""

    keyframes: list[KeyframeSpec]
    commits_df: pl.DataFrame
    touches_df: pl.DataFrame

    def stats_for_keyframe(self, keyframe: KeyframeSpec) -> dict[str, FileHistoryStats]:
        """Compute rolling 90-day churn, bug-fix count, and bus factor up to `keyframe`."""
        if self.touches_df.is_empty():
            return {}
        end_ts = keyframe.committed_at.astimezone(UTC).replace(tzinfo=None)
        start_ts = end_ts - timedelta(days=ROLLING_WINDOW_DAYS)

        window = (
            self.touches_df.filter(
                (pl.col("committed_at") >= start_ts) & (pl.col("committed_at") <= end_ts)
            )
            .group_by("file_path")
            .agg(
                pl.col("commit_sha").n_unique().alias("commits_90d"),
                pl.col("lines_changed").sum().alias("lines_90d"),
                pl.col("is_bugfix").cast(pl.Int32).sum().alias("bugfix_commits_90d"),
                pl.col("author_email").n_unique().alias("distinct_authors_90d"),
            )
        )
        stats: dict[str, FileHistoryStats] = {}
        for row in window.iter_rows(named=True):
            # Combine commit count + scaled line delta so active blocks stand out cleanly
            churn = int(row["commits_90d"]) + min(50, int(row["lines_90d"]) // 40)
            stats[str(row["file_path"])] = FileHistoryStats(
                churn_90d=max(int(row["commits_90d"]), churn),
                bugfix_commits_90d=int(row["bugfix_commits_90d"]),
                distinct_authors_90d=int(row["distinct_authors_90d"]),
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
        if self.touches_df.is_empty() or not active_files:
            return []

        end_ts = keyframe.committed_at.astimezone(UTC).replace(tzinfo=None)
        hist = self.touches_df.filter(
            (pl.col("committed_at") <= end_ts) & pl.col("file_path").is_in(list(active_files))
        )
        if hist.is_empty():
            return []

        file_commit_counts: dict[str, int] = defaultdict(int)
        commit_files: dict[str, list[str]] = defaultdict(list)

        for row in hist.select(["commit_sha", "file_path"]).iter_rows():
            sha, fpath = str(row[0]), str(row[1])
            commit_files[sha].append(fpath)
            file_commit_counts[fpath] += 1

        pair_counts: dict[tuple[str, str], int] = defaultdict(int)
        for files in commit_files.values():
            uniq = sorted(set(files))
            if len(uniq) < 2 or len(uniq) > MAX_COCHANGE_FILES_PER_COMMIT:
                continue
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


def _run_git(repo_path: Path, args: list[str]) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo_path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )
    return proc.stdout


def resolve_git_repo(source: str, clones_dir: Path) -> Path:
    """Resolve a local repository path or clone a remote public Git URL into `clones_dir`."""
    local_candidate = Path(source).expanduser()
    if local_candidate.exists():
        resolved = local_candidate.resolve()
        top = _run_git(resolved, ["rev-parse", "--show-toplevel"]).strip()
        return Path(top)

    if source.startswith(("http://", "https://", "git@", "ssh://")):
        clones_dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", source.rstrip("/").removesuffix(".git"))
        dest = clones_dir / slug
        if (dest / ".git").exists():
            subprocess.run(
                ["git", "-C", str(dest), "fetch", "--tags", "--quiet"],
                check=False,
                capture_output=True,
            )
            return dest
        subprocess.run(
            ["git", "clone", "--quiet", source, str(dest)],
            check=True,
            capture_output=True,
            text=True,
        )
        return dest

    raise FileNotFoundError(f"Git repository source not found: {source}")


def _list_tags_by_commit(repo_path: Path) -> dict[str, str]:
    try:
        out = _run_git(repo_path, ["show-ref", "--tags", "--dereference"])
    except subprocess.CalledProcessError:
        return {}
    tags: dict[str, str] = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        sha, ref = parts[0], parts[1]
        name = ref.removeprefix("refs/tags/").removesuffix("^{}")
        # Prefer dereferenced tag SHA if both annotated and dereferenced lines appear
        if ref.endswith("^{}") or sha not in tags:
            tags[sha] = name
    return tags


def parse_git_history(
    repo_path: Path,
    *,
    max_keyframes: int = 16,
) -> GitHistoryAnalysis:
    """Stream `git log --numstat` into Polars and select evenly spaced + tagged keyframes."""
    raw = _run_git(
        repo_path,
        [
            "log",
            "--reverse",
            "--no-renames",
            "--numstat",
            "--format=__CODECITY_COMMIT__%H%x00%aI%x00%ae%x00%s",
        ],
    )
    tags_by_sha = _list_tags_by_commit(repo_path)

    commit_rows: list[dict[str, object]] = []
    touch_rows: list[dict[str, object]] = []

    cur_sha = ""
    cur_ts = datetime.now(UTC).replace(tzinfo=None)
    cur_author = ""
    cur_bugfix = False

    for line in raw.splitlines():
        if line.startswith("__CODECITY_COMMIT__"):
            payload = line.removeprefix("__CODECITY_COMMIT__")
            parts = payload.split("\x00", 3)
            if len(parts) < 4:
                continue
            cur_sha, ts_str, cur_author, subject = parts
            dt = datetime.fromisoformat(ts_str)
            cur_ts = dt.astimezone(UTC).replace(tzinfo=None)
            cur_bugfix = bool(BUGFIX_RE.search(subject))
            commit_rows.append(
                {
                    "commit_sha": cur_sha,
                    "committed_at": cur_ts,
                    "author_email": cur_author,
                    "is_bugfix": cur_bugfix,
                    "git_tag": tags_by_sha.get(cur_sha),
                }
            )
            continue

        if not line.strip() or not cur_sha:
            continue
        fields = line.split("\t", 2)
        if len(fields) != 3:
            continue
        ins_s, del_s, fpath = fields
        ins = int(ins_s) if ins_s.isdigit() else 0
        dels = int(del_s) if del_s.isdigit() else 0
        touch_rows.append(
            {
                "commit_sha": cur_sha,
                "committed_at": cur_ts,
                "author_email": cur_author,
                "is_bugfix": cur_bugfix,
                "file_path": fpath.strip(),
                "lines_changed": ins + dels,
            }
        )

    commits_df = (
        pl.DataFrame(commit_rows)
        if commit_rows
        else pl.DataFrame(
            schema={
                "commit_sha": pl.String,
                "committed_at": pl.Datetime("us"),
                "author_email": pl.String,
                "is_bugfix": pl.Boolean,
                "git_tag": pl.String,
            }
        )
    )
    touches_df = (
        pl.DataFrame(touch_rows)
        if touch_rows
        else pl.DataFrame(
            schema={
                "commit_sha": pl.String,
                "committed_at": pl.Datetime("us"),
                "author_email": pl.String,
                "is_bugfix": pl.Boolean,
                "file_path": pl.String,
                "lines_changed": pl.Int64,
            }
        )
    )

    keyframes = select_keyframes(commit_rows, max_keyframes=max_keyframes)
    return GitHistoryAnalysis(keyframes=keyframes, commits_df=commits_df, touches_df=touches_df)


def select_keyframes(
    commits_chronological: list[dict[str, object]],
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
        tagged_indices = [
            i for i, c in enumerate(commits_chronological) if c.get("git_tag") is not None
        ]
        # Include up to half the budget from tagged releases evenly
        if tagged_indices:
            tag_budget = max(1, max_keyframes // 2)
            if len(tagged_indices) <= tag_budget:
                chosen_set.update(tagged_indices)
            else:
                step = (len(tagged_indices) - 1) / max(1, tag_budget - 1)
                for j in range(tag_budget):
                    chosen_set.add(tagged_indices[round(j * step)])

        # Fill remaining slots evenly across commit timeline
        remaining = max_keyframes - len(chosen_set)
        if remaining > 0:
            step = (n - 1) / max(1, max_keyframes - 1)
            for j in range(max_keyframes):
                if len(chosen_set) >= max_keyframes:
                    break
                chosen_set.add(round(j * step))
        chosen_indices = sorted(chosen_set)[:max_keyframes]

    keyframes: list[KeyframeSpec] = []
    for snap_idx, ci in enumerate(chosen_indices):
        row = commits_chronological[ci]
        dt = row["committed_at"]
        assert isinstance(dt, datetime)
        keyframes.append(
            KeyframeSpec(
                snapshot_idx=snap_idx,
                commit_sha=str(row["commit_sha"]),
                committed_at=dt.replace(tzinfo=UTC),
                git_tag=str(row["git_tag"]) if row.get("git_tag") else None,
            )
        )
    return keyframes

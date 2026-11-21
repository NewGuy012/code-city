"""End-to-end two-pass polyglot repository analyzer writing concurrently over Quack."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any

from codecity.analyzer.git_history import KeyframeSpec, parse_git_history, resolve_git_repo
from codecity.analyzer.layout import compute_stable_city_layout
from codecity.analyzer.plugins import run_all_plugins
from codecity.analyzer.role_classifier import build_snapshot_metrics, hint_zone_for_path
from codecity.analyzer.treesitter_core import detect_language, scan_worktree_ast
from codecity.analyzer.worktree import WorktreeManager, list_keyframe_file_sizes
from codecity.models import RepoRef
from codecity.storage.lakehouse import LakehouseManager, infer_owner_repo
from codecity.storage.quack_server import QuackServerManager

ProgressCallback = Callable[[dict[str, Any]], None]


@dataclass
class AnalyzeSummary:
    """Result returned after completing a full repository analysis run."""

    repo: RepoRef
    snapshots_written: int
    total_files_latest: int


def analyze_repository(
    source: str,
    *,
    lakehouse: LakehouseManager | None = None,
    quack_server: QuackServerManager | None = None,
    owner: str | None = None,
    repo: str | None = None,
    max_keyframes: int = 16,
    workers: int = 4,
    semantic: bool = False,
    on_progress: ProgressCallback | None = None,
) -> AnalyzeSummary:
    """Run Pass 1 (Git history) and Pass 2 (parallel worktrees -> Quack -> DuckLake)."""
    lake = lakehouse or LakehouseManager()
    resolved_owner, resolved_repo = infer_owner_repo(source, owner=owner, repo=repo)

    def emit(stage: str, message: str, percent: float, **extra: Any) -> None:
        if on_progress is not None:
            on_progress(
                {
                    "stage": stage,
                    "message": message,
                    "percent": round(percent, 1),
                    "owner": resolved_owner,
                    "repo": resolved_repo,
                    **extra,
                }
            )

    emit("resolve", f"Resolving repository `{source}`...", 5.0)
    repo_path = resolve_git_repo(source, lake.data_dir / "clones")

    emit("git_history", "Pass 1: Streaming `git log --numstat` history...", 15.0)
    history = parse_git_history(repo_path, max_keyframes=max_keyframes)
    if not history.keyframes:
        raise ValueError(f"Repository has no commits: {repo_path}")

    emit(
        "layout",
        f"Building stable SimCity grid across {len(history.keyframes)} keyframes...",
        25.0,
        total_keyframes=len(history.keyframes),
    )
    union_weights = list_keyframe_file_sizes(repo_path, history.keyframes)
    zone_hints = {p: [hint_zone_for_path(p, detect_language(p)[0])] for p in union_weights}
    file_layout, district_layout = compute_stable_city_layout(union_weights, zone_hints)

    wt_mgr = WorktreeManager(repo_path)
    total_kf = len(history.keyframes)
    latest_files_count = 0

    server_ctx = nullcontext(quack_server) if quack_server is not None else QuackServerManager(lake)
    with server_ctx as qsrv:
        with qsrv.host_cursor() as con:
            schema_path = lake.ensure_repo_schema(
                con,
                resolved_owner,
                resolved_repo,
                str(source),
            )
            lake.clear_repo_analysis_data(
                con,
                resolved_owner,
                resolved_repo,
                preserve_annotations=True,
            )

        def process_keyframe(kf: KeyframeSpec) -> tuple[int, int]:
            with wt_mgr.checkout(kf.commit_sha) as wt_dir:
                ast_files = scan_worktree_ast(wt_dir)
                plugin_res = run_all_plugins(wt_dir, kf.snapshot_idx, ast_files)

            h_stats = history.stats_for_keyframe(kf)
            cochanges = history.cochanges_for_keyframe(kf, set(ast_files.keys()))
            snapshot, districts, file_metrics = build_snapshot_metrics(
                kf,
                ast_files,
                plugin_res,
                h_stats,
                file_layout,
                district_layout,
            )

            if semantic and kf.snapshot_idx == total_kf - 1:
                try:
                    from codecity.analyzer.semantic import enrich_head_districts

                    enrich_head_districts(repo_path, districts)
                except Exception:
                    pass

            client = qsrv.connect_client(alias="remote")
            try:
                lake.write_snapshot_bundle(
                    client,
                    resolved_owner,
                    resolved_repo,
                    snapshot,
                    districts,
                    file_metrics,
                    plugin_res.imports,
                    cochanges,
                    plugin_res.external_deps,
                    plugin_res.diagnostics,
                    catalog_prefix=f"remote.{lake.catalog_name}",
                )
            finally:
                client.close()
            return kf.snapshot_idx, len(file_metrics)

        max_workers = max(1, min(workers, total_kf))
        completed = 0
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(process_keyframe, kf): kf for kf in history.keyframes}
            for fut in as_completed(futures):
                snap_idx, file_cnt = fut.result()
                completed += 1
                if snap_idx == total_kf - 1:
                    latest_files_count = file_cnt
                pct = 28.0 + (completed / total_kf) * 68.0
                emit(
                    "keyframe",
                    f"Analyzed keyframe {completed}/{total_kf} "
                    f"(snapshot #{snap_idx}, {file_cnt} files)",
                    pct,
                    completed=completed,
                    total_keyframes=total_kf,
                )

        with qsrv.host_cursor() as con:
            matched = lake.get_repo(con, resolved_owner, resolved_repo) or RepoRef(
                owner=resolved_owner,
                repo=resolved_repo,
                schema_path=schema_path,
                repo_url_or_path=str(source),
                latest_snapshot_idx=total_kf - 1,
                total_snapshots=total_kf,
                total_files=latest_files_count,
            )

    emit("done", f"City complete: {matched.latest_grade} · {matched.latest_title}", 100.0)
    return AnalyzeSummary(
        repo=matched,
        snapshots_written=total_kf,
        total_files_latest=latest_files_count,
    )

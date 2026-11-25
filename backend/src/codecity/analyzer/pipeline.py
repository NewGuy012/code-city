"""End-to-end two-pass polyglot repository analyzer writing concurrently over Quack."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import nullcontext, suppress
from dataclasses import dataclass
from typing import Any

from codecity.analyzer.briefing import build_city_briefing
from codecity.analyzer.git_history import KeyframeSpec, parse_git_history, resolve_git_repo
from codecity.analyzer.layout import compute_stable_city_layout
from codecity.analyzer.llm_summarizer import (
    enhance_building_description_with_llm,
    enhance_city_briefing_with_llm,
)
from codecity.analyzer.plugins import run_all_plugins
from codecity.analyzer.plugins.base import safe_read_text
from codecity.analyzer.role_classifier import build_snapshot_metrics, hint_zone_for_path
from codecity.analyzer.semantic import (
    RepoDocsContext,
    enrich_head_districts,
    enrich_head_file_descriptions,
    extract_repo_docs_context,
)
from codecity.analyzer.treesitter_core import detect_language, scan_worktree_ast
from codecity.analyzer.worktree import WorktreeManager, list_keyframe_file_sizes
from codecity.models import BuildingDescription, FileMetric, RepoRef
from codecity.storage.lakehouse import LakehouseManager, infer_owner_repo
from codecity.storage.llm_cache import LlmSummaryCache, hash_text
from codecity.storage.quack_server import QuackServerManager

ProgressCallback = Callable[[dict[str, Any]], None]


@dataclass
class AnalyzeSummary:
    """Result returned after completing a full repository analysis run."""

    repo: RepoRef
    snapshots_written: int
    total_files_latest: int


def _apply_head_llm_file_summaries(
    file_metrics: list[FileMetric],
    head_sources: dict[str, str],
    *,
    repo_slug: str,
    docs_ctx: RepoDocsContext,
    llm_mode: str,
    cache: LlmSummaryCache,
) -> None:
    if llm_mode == "off" or not file_metrics:
        return

    overview_ctx = docs_ctx.overview[:300]
    if llm_mode != "head":
        # Zero-latency cache hydration for unchanged files already summarized previously
        for fm in file_metrics:
            src = head_sources.get(fm.file_path)
            raw_desc = fm.role_signals.get("description")
            if not src or not isinstance(raw_desc, dict):
                continue
            desc = BuildingDescription.model_validate(raw_desc)
            chash = hash_text(src[:12000])
            xhash = hash_text(overview_ctx + (desc.readme_context or ""))
            hit = cache.get_any_for_content("file", chash, xhash)
            if hit is not None:
                from codecity.analyzer.llm_summarizer import _apply_file_llm_payload

                fm.role_signals["description"] = _apply_file_llm_payload(
                    desc, hit[0], hit[1], hit[2]
                ).model_dump(mode="json")
        return

    # `--llm head`: eagerly summarize prioritized non-trivial HEAD files
    candidates = [
        fm
        for fm in file_metrics
        if fm.sloc >= 8
        and fm.file_path in head_sources
        and isinstance(fm.role_signals.get("description"), dict)
    ]
    candidates.sort(
        key=lambda f: (
            int(f.condition_flags.get("fan_in", 0) or 0) * 10 + min(f.sloc, 400),
            -f.type_or_doc_ratio,
        ),
        reverse=True,
    )
    targets = candidates[:60]

    def _summarize(fm: FileMetric) -> tuple[FileMetric, BuildingDescription]:
        desc = BuildingDescription.model_validate(fm.role_signals["description"])
        updated = enhance_building_description_with_llm(
            desc,
            file_path=fm.file_path,
            source_text=head_sources[fm.file_path],
            repo_name=repo_slug,
            docs_ctx=docs_ctx,
            repo_slug=repo_slug,
            cache=cache,
        )
        return fm, updated

    with ThreadPoolExecutor(max_workers=2) as llm_pool:
        for fm, updated in llm_pool.map(_summarize, targets):
            fm.role_signals["description"] = updated.model_dump(mode="json")


def analyze_repository(
    source: str,
    *,
    lakehouse: LakehouseManager | None = None,
    quack_server: QuackServerManager | None = None,
    owner: str | None = None,
    repo: str | None = None,
    max_keyframes: int = 16,
    workers: int = 4,
    semantic: bool = True,
    llm_mode: str = "auto",
    on_progress: ProgressCallback | None = None,
) -> AnalyzeSummary:
    """Run Pass 1 (Git history) and Pass 2 (parallel worktrees -> Quack -> DuckLake)."""
    lake = lakehouse or LakehouseManager()
    resolved_owner, resolved_repo = infer_owner_repo(source, owner=owner, repo=repo)
    repo_slug = f"{resolved_owner}/{resolved_repo}"
    llm_cache = LlmSummaryCache(lake.data_dir / "llm_cache.sqlite")

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
            lake.clear_repo_analysis_data(con, resolved_owner, resolved_repo)

        def process_keyframe(kf: KeyframeSpec) -> tuple[int, int]:
            is_head = kf.snapshot_idx == total_kf - 1
            head_docs_ctx: RepoDocsContext | None = None
            head_sources: dict[str, str] = {}
            with wt_mgr.checkout(kf.commit_sha) as wt_dir:
                ast_files = scan_worktree_ast(wt_dir)
                plugin_res = run_all_plugins(wt_dir, kf.snapshot_idx, ast_files)
                if is_head:
                    head_docs_ctx = (
                        extract_repo_docs_context(wt_dir)
                        if semantic
                        else RepoDocsContext(title=resolved_repo)
                    )
                    if llm_mode != "off":
                        for rel_path in ast_files:
                            txt = safe_read_text(wt_dir, wt_dir / rel_path)
                            if txt:
                                head_sources[rel_path] = txt[:12000]

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

            if is_head:
                docs_ctx = head_docs_ctx or RepoDocsContext(title=resolved_repo)
                if semantic:
                    with suppress(Exception):
                        enrich_head_districts(repo_path, districts, docs_ctx=docs_ctx)
                        enrich_head_file_descriptions(docs_ctx, file_metrics)
                with suppress(Exception):
                    _apply_head_llm_file_summaries(
                        file_metrics,
                        head_sources,
                        repo_slug=repo_slug,
                        docs_ctx=docs_ctx,
                        llm_mode=llm_mode,
                        cache=llm_cache,
                    )
                briefing = build_city_briefing(
                    repo_slug,
                    docs_ctx,
                    districts,
                    file_metrics,
                    plugin_res.imports,
                    city_title=snapshot.city_archetype_title,
                    health_grade=snapshot.health_grade,
                )
                if llm_mode != "off":
                    with suppress(Exception):
                        briefing = enhance_city_briefing_with_llm(
                            briefing,
                            docs_ctx,
                            repo_slug=repo_slug,
                            cache=llm_cache,
                        )
                snapshot.city_briefing = briefing

            with qsrv.client_session(alias="remote") as client:
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

"""Deterministic SimCity zoning, 10 building archetypes, health scoring & City Advisor alerts."""

from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from codecity.analyzer.git_history import FileHistoryStats, KeyframeSpec
from codecity.analyzer.plugins.base import PluginResult
from codecity.analyzer.treesitter_core import AstFileInfo
from codecity.models import (
    AdvisorAlert,
    BuildingArchetype,
    District,
    FileImport,
    FileMetric,
    Snapshot,
    ZoneType,
)


def district_for_file(file_path: str) -> str:
    """Group files into readable neighborhood districts (depth 1-2 meaningful prefixes)."""
    parts = list(Path(file_path).parent.parts)
    if not parts:
        return "root"
    # Skip boilerplate top containers like `src`, `pkg`, `lib`, `app` when deeper modules exist
    if len(parts) >= 2 and parts[0] in {"src", "lib", "pkg", "app", "crates"}:
        return "/".join(parts[:2])
    if len(parts) >= 3 and parts[1] in {"src", "lib"}:
        return "/".join(parts[:3])
    if len(parts) >= 4 and parts[2] in {"src", "lib"}:
        return "/".join(parts[:4])
    return "/".join(parts[:2])


_DISTRICT_ZONE_RULES: tuple[tuple[tuple[str, ...], ZoneType], ...] = (
    (("test", "spec", "bench", "fixture", "e2e"), ZoneType.GREENBELT_PARKS),
    (
        ("api", "route", "controller", "handler", "endpoint", "cli", "cmd", "gateway"),
        ZoneType.HARBOR_GATES,
    ),
    (
        ("db", "storage", "sql", "schema", "model", "migration", "repo", "lake", "cache"),
        ZoneType.VAULTS_RESERVOIR,
    ),
    (
        ("ui", "component", "page", "view", "frontend", "web", "style", "city", "studio"),
        ZoneType.GALLERY_STOREFRONT,
    ),
    (
        ("worker", "pipeline", "etl", "parser", "compiler", "analyzer", "compute", "engine"),
        ZoneType.INDUSTRIAL_QUARTER,
    ),
    (
        ("auth", "middleware", "config", "util", "helper", "telemetry", "log", "common"),
        ZoneType.CIVIC_UTILITIES,
    ),
    (("core", "domain", "service", "kernel", "server"), ZoneType.DOWNTOWN_CORE),
)

_GRADE_THRESHOLDS: tuple[tuple[float, str], ...] = (
    (92, "A+"),
    (85, "A"),
    (80, "A-"),
    (74, "B+"),
    (68, "B"),
    (60, "C+"),
    (50, "C"),
)


_ENTRYPOINT_NAMES = frozenset(
    {"main.py", "cli.py", "app.py", "main.go", "main.rs", "lib.rs", "index.ts", "server.ts"}
)


def hint_zone_for_path(rel_path: str, language: str) -> ZoneType:
    """Lightweight pre-AST zone hint for stable layout grouping."""
    low = rel_path.lower()
    if Path(low).name in _ENTRYPOINT_NAMES:
        return ZoneType.HARBOR_GATES
    if language == "config":
        return ZoneType.CIVIC_UTILITIES
    return classify_district_zone(low, [])


def classify_district_zone(
    district_path: str,
    file_zones: list[ZoneType],
) -> ZoneType:
    """Assign one of the 8 SimCity District Zones to a directory neighborhood."""
    low = district_path.lower()
    for keywords, zone in _DISTRICT_ZONE_RULES:
        if any(k in low for k in keywords):
            return zone
    if file_zones:
        return Counter(file_zones).most_common(1)[0][0]
    return ZoneType.DOWNTOWN_CORE


def compute_import_centrality(
    file_paths: list[str],
    imports: list[FileImport],
) -> tuple[dict[str, int], dict[str, int], dict[str, float]]:
    """Compute `(fan_in, fan_out, pagerank)` over the directed module import graph."""
    fan_in: dict[str, int] = {p: 0 for p in file_paths}
    fan_out: dict[str, int] = {p: 0 for p in file_paths}
    adj: dict[str, list[str]] = defaultdict(list)

    for edge in imports:
        if edge.source_file in fan_out and edge.target_file in fan_in:
            fan_out[edge.source_file] += 1
            fan_in[edge.target_file] += 1
            adj[edge.source_file].append(edge.target_file)

    n = max(1, len(file_paths))
    rank = {p: 1.0 / n for p in file_paths}
    damping = 0.85
    for _ in range(12):
        new_rank = {p: (1.0 - damping) / n for p in file_paths}
        for src in file_paths:
            targets = adj.get(src, [])
            if not targets:
                continue
            share = damping * rank[src] / len(targets)
            for dst in targets:
                new_rank[dst] += share
        rank = new_rank

    max_pr = max(rank.values(), default=1.0) or 1.0
    norm_pr = {p: round(v / max_pr, 4) for p, v in rank.items()}
    return fan_in, fan_out, norm_pr


def classify_building_archetype(
    info: AstFileInfo,
    *,
    fan_in: int,
    fan_out: int,
    pagerank: float,
) -> tuple[BuildingArchetype, ZoneType, float, dict[str, Any]]:
    """Classify a file into one of the 10 SimCity Building Archetypes and return signals."""
    low = info.file_path.lower()
    name = Path(low).name
    sig = info.signals

    def _match(
        archetype: BuildingArchetype,
        zone: ZoneType,
        confidence: float,
        reason: str,
    ) -> tuple[BuildingArchetype, ZoneType, float, dict[str, Any]]:
        return (
            archetype,
            zone,
            confidence,
            {"reasons": [reason], "fan_in": fan_in, "fan_out": fan_out, "pagerank": pagerank},
        )

    if sig.get("is_test") or info.file_path.endswith("_test.go"):
        return _match(
            BuildingArchetype.PARK_STADIUM,
            ZoneType.GREENBELT_PARKS,
            0.96,
            "Test or benchmark file pattern",
        )

    if sig.get("ui_hints") or any(
        k in low for k in ("/components/", "/views/", "/pages/", "/city/", ".css")
    ):
        return _match(
            BuildingArchetype.GLASS_PAVILION,
            ZoneType.GALLERY_STOREFRONT,
            0.9,
            "UI component / JSX / view layer",
        )

    if (
        sig.get("has_main")
        or sig.get("route_hints")
        or sig.get("cli_hints")
        or name in _ENTRYPOINT_NAMES
        or any(k in low for k in ("/routes", "/router", "/api/", "/cmd/", "endpoint"))
    ):
        return _match(
            BuildingArchetype.GRAND_TERMINAL,
            ZoneType.HARBOR_GATES,
            0.88,
            "Entrypoint, HTTP router, or CLI handler",
        )

    if sig.get("db_hints") or any(
        k in low
        for k in (
            "storage",
            "lakehouse",
            "quack",
            "database",
            "db.",
            "repo",
            "migration",
            "sql",
            "cache",
        )
    ):
        return _match(
            BuildingArchetype.TWIN_SILOS,
            ZoneType.VAULTS_RESERVOIR,
            0.87,
            "Storage, database, lakehouse, or persistence IO",
        )

    type_defs = int(sig.get("type_def_count") or 0)
    funcs = int(sig.get("func_count") or 0)
    if any(k in low for k in ("models", "schema", "types", "dto", "entities", "contracts")) or (
        type_defs >= 2 and info.max_complexity <= 3 and type_defs >= funcs
    ):
        return _match(
            BuildingArchetype.ARCHIVE_VAULT,
            ZoneType.VAULTS_RESERVOIR,
            0.85,
            "High type/model density with low branching",
        )

    if (
        sig.get("auth_hints")
        or any(
            k in low
            for k in ("auth", "config", "settings", "middleware", "guard", "security", "env")
        )
        or info.language == "config"
    ):
        return _match(
            BuildingArchetype.WATCHTOWER,
            ZoneType.CIVIC_UTILITIES,
            0.84,
            "Auth, security guard, middleware, or configuration",
        )

    if pagerank >= 0.55 or fan_in >= 5 or (fan_in >= 3 and fan_out >= 3):
        return _match(
            BuildingArchetype.CITY_HALL,
            ZoneType.DOWNTOWN_CORE,
            0.86,
            f"High import centrality (fan-in {fan_in}, PageRank {pagerank:.2f})",
        )

    loops = int(sig.get("loop_count") or 0)
    if (
        info.max_complexity >= 7
        or loops >= 3
        or any(
            k in low
            for k in ("worker", "pipeline", "parser", "analyzer", "compiler", "engine", "layout")
        )
    ):
        return _match(
            BuildingArchetype.FACTORY,
            ZoneType.INDUSTRIAL_QUARTER,
            0.82,
            f"Compute/pipeline logic (complexity {info.max_complexity}, loops {loops})",
        )

    if any(k in low for k in ("util", "helper", "common", "shared", "format", "slug")) or (
        info.sloc <= 120 and fan_in >= 2
    ):
        return _match(
            BuildingArchetype.CIVIC_KIOSK,
            ZoneType.CIVIC_UTILITIES,
            0.78,
            "Compact shared utility or helper module",
        )

    return _match(
        BuildingArchetype.OFFICE_TOWER,
        ZoneType.DOWNTOWN_CORE,
        0.72,
        "General domain service / business logic module",
    )


def grade_and_title(health_score: float, total_lint: int, max_churn: int) -> tuple[str, str]:
    """Map numeric health score into SimCity Repo Grade & Persona title."""
    grade = next((g for floor, g in _GRADE_THRESHOLDS if health_score >= floor), "D")
    if health_score >= 84 and total_lint <= 15:
        title = "Sunlit Civic Metropolis"
    elif max_churn >= 15 and health_score >= 70:
        title = "Booming Frontier Town"
    elif total_lint > 40 and health_score < 68:
        title = "Smoggy Industrial Harbor"
    elif health_score >= 70:
        title = "Bustling Harbor District"
    else:
        title = "High-Voltage Refactor Zone"
    return grade, title


def build_snapshot_metrics(
    keyframe: KeyframeSpec,
    ast_files: dict[str, AstFileInfo],
    plugin_result: PluginResult,
    history_stats: dict[str, FileHistoryStats],
    layout_map: dict[str, tuple[float, float, float, float]],
    district_bounds: dict[str, tuple[float, float, float, float, ZoneType]],
) -> tuple[Snapshot, list[District], list[FileMetric]]:
    """Assemble Snapshot, Districts, and FileMetrics with archetypes, health & Advisor alerts."""
    file_paths = sorted(ast_files.keys())
    fan_in, fan_out, pagerank = compute_import_centrality(file_paths, plugin_result.imports)

    diags_by_file: dict[str, Counter[str]] = defaultdict(Counter)
    diag_totals: dict[str, int] = defaultdict(int)
    for d in plugin_result.diagnostics:
        diags_by_file[d.file_path][d.category] += 1
        diag_totals[d.file_path] += 1

    # Compute dynamic churn threshold for cranes (top active files)
    churn_values = sorted(
        (history_stats[p].churn_90d for p in file_paths if p in history_stats),
        reverse=True,
    )
    crane_threshold = max(
        4,
        churn_values[max(0, min(len(churn_values) - 1, len(churn_values) // 6))]
        if churn_values
        else 4,
    )

    file_metrics: list[FileMetric] = []
    district_files: dict[str, list[FileMetric]] = defaultdict(list)
    district_file_zones: dict[str, list[ZoneType]] = defaultdict(list)
    lang_counts: Counter[str] = Counter()

    for rel in file_paths:
        info = ast_files[rel]
        lang_counts[info.language] += 1
        dpath = district_for_file(rel)
        archetype, zone, conf, role_signals = classify_building_archetype(
            info,
            fan_in=fan_in.get(rel, 0),
            fan_out=fan_out.get(rel, 0),
            pagerank=pagerank.get(rel, 0.0),
        )
        h = history_stats.get(
            rel, FileHistoryStats(churn_90d=0, bugfix_commits_90d=0, distinct_authors_90d=1)
        )
        lint_count = diag_totals.get(rel, 0)
        fmt_drift = rel in plugin_result.format_drift_files

        # Hotspot formula combines churn, complexity, bugfixes, and lint debt
        hotspot = round(
            (h.churn_90d * 1.4 + h.bugfix_commits_90d * 2.5) * (1.0 + info.max_complexity / 12.0)
            + lint_count * 0.35,
            2,
        )

        is_crane = h.churn_90d >= crane_threshold and h.churn_90d > 0
        is_smog = lint_count >= 3 or fmt_drift
        is_lone_keeper = h.distinct_authors_90d == 1 and (
            fan_in.get(rel, 0) >= 3 or pagerank.get(rel, 0.0) >= 0.45
        )
        flags = {
            "crane": is_crane,
            "smog": is_smog,
            "lone_keeper": is_lone_keeper,
            "format_drift": fmt_drift,
            "high_complexity": info.max_complexity >= 10,
            "fan_in": fan_in.get(rel, 0),
            "fan_out": fan_out.get(rel, 0),
        }

        lx, lz, lw, ld = layout_map.get(rel, (0.0, 0.0, 2.0, 2.0))
        fm = FileMetric(
            snapshot_idx=keyframe.snapshot_idx,
            file_path=rel,
            district_path=dpath,
            language=info.language,
            zone_type=zone,
            building_archetype=archetype,
            role_confidence=conf,
            role_signals=role_signals,
            sloc=info.sloc,
            symbol_count=info.symbol_count,
            max_complexity=info.max_complexity,
            type_or_doc_ratio=info.type_or_doc_ratio,
            lint_issue_count=lint_count,
            format_drift=fmt_drift,
            lint_by_category=dict(diags_by_file[rel]),
            churn_90d=h.churn_90d,
            bugfix_commits_90d=h.bugfix_commits_90d,
            distinct_authors_90d=h.distinct_authors_90d,
            hotspot_score=hotspot,
            condition_flags=flags,
            layout_x=lx,
            layout_z=lz,
            layout_w=lw,
            layout_d=ld,
        )
        file_metrics.append(fm)
        district_files[dpath].append(fm)
        district_file_zones[dpath].append(zone)

    # Build Districts with zone summary
    districts: list[District] = []
    for dpath, members in sorted(district_files.items()):
        bx, bz, bw, bd, fixed_zone = district_bounds.get(
            dpath,
            (0.0, 0.0, 10.0, 10.0, classify_district_zone(dpath, district_file_zones[dpath])),
        )
        avg_lint = sum(m.lint_issue_count for m in members) / max(1, len(members))
        avg_comp = sum(m.max_complexity for m in members) / max(1, len(members))
        avg_health = round(max(25.0, 100.0 - avg_lint * 4.5 - max(0.0, avg_comp - 5.0) * 2.2), 1)
        top_arch = Counter(m.building_archetype.value for m in members).most_common(1)[0][0]
        arch_label = top_arch.replace("_", " ")
        blurb = f"{len(members)} modules · primary {arch_label} · avg health {avg_health:.0f}%"
        districts.append(
            District(
                snapshot_idx=keyframe.snapshot_idx,
                district_path=dpath,
                display_name=dpath,
                zone_type=fixed_zone,
                bounds_x=bx,
                bounds_z=bz,
                bounds_w=bw,
                bounds_d=bd,
                file_count=len(members),
                avg_health=avg_health,
                summary_blurb=blurb,
            )
        )

    total_files = len(file_metrics)
    total_sloc = sum(m.sloc for m in file_metrics)
    total_lint = sum(m.lint_issue_count for m in file_metrics)
    test_sloc = sum(
        m.sloc for m in file_metrics if m.building_archetype == BuildingArchetype.PARK_STADIUM
    )
    fmt_drift_count = sum(1 for m in file_metrics if m.format_drift)
    avg_comp_all = sum(m.max_complexity for m in file_metrics) / max(1, total_files)
    test_ratio = test_sloc / max(1, total_sloc)

    # City Health Score (0..100)
    lint_penalty = min(30.0, (total_lint / max(1, total_files)) * 6.5)
    drift_penalty = min(10.0, (fmt_drift_count / max(1, total_files)) * 18.0)
    complexity_penalty = min(20.0, max(0.0, avg_comp_all - 4.0) * 2.2)
    greenbelt_bonus = min(10.0, test_ratio * 30.0)
    health_score = round(
        max(
            15.0,
            min(99.0, 92.0 - lint_penalty - drift_penalty - complexity_penalty + greenbelt_bonus),
        ),
        1,
    )
    max_churn = max((m.churn_90d for m in file_metrics), default=0)
    health_grade, city_title = grade_and_title(health_score, total_lint, max_churn)

    advisor_alerts = _build_advisor_alerts(
        file_metrics,
        districts,
        test_ratio=test_ratio,
        total_lint=total_lint,
        fmt_drift_count=fmt_drift_count,
    )

    snapshot = Snapshot(
        snapshot_idx=keyframe.snapshot_idx,
        commit_sha=keyframe.commit_sha,
        committed_at=keyframe.committed_at,
        git_tag=keyframe.git_tag,
        total_files=total_files,
        total_sloc=total_sloc,
        total_lint_issues=total_lint,
        language_breakdown=dict(lang_counts),
        health_score=health_score,
        health_grade=health_grade,
        city_archetype_title=city_title,
        advisor_alerts=advisor_alerts,
    )
    return snapshot, districts, file_metrics


def _build_advisor_alerts(
    files: list[FileMetric],
    districts: list[District],
    *,
    test_ratio: float,
    total_lint: int,
    fmt_drift_count: int,
) -> list[AdvisorAlert]:
    alerts: list[AdvisorAlert] = []
    if not files:
        return alerts

    top_hotspot = max(files, key=lambda f: f.hotspot_score)
    if top_hotspot.hotspot_score > 0:
        alerts.append(
            AdvisorAlert(
                severity="warn" if top_hotspot.hotspot_score >= 12 else "info",
                icon="🏗️",
                title=f"Construction surge in `{top_hotspot.district_path}/`",
                detail=(
                    f"`{top_hotspot.file_path}` leads city churn "
                    f"({top_hotspot.churn_90d} commits/90d, "
                    f"hotspot {top_hotspot.hotspot_score:.1f})."
                ),
                target_path=top_hotspot.file_path,
            )
        )

    lone_hubs = [f for f in files if f.condition_flags.get("lone_keeper")]
    if lone_hubs:
        hub = max(lone_hubs, key=lambda f: int(f.condition_flags.get("fan_in", 0)))
        fan = int(hub.condition_flags.get("fan_in", 0))
        alerts.append(
            AdvisorAlert(
                severity="critical" if fan >= 6 else "warn",
                icon="🚨",
                title=f"Transit Advisory: `{hub.file_path}` Bus Factor = 1",
                detail=f"Feeds {fan} importing modules with a solitary 90-day maintainer.",
                target_path=hub.file_path,
            )
        )

    if total_lint > 0 or fmt_drift_count > 0:
        worst_lint = max(files, key=lambda f: f.lint_issue_count)
        alerts.append(
            AdvisorAlert(
                severity="warn" if total_lint > 15 else "info",
                icon="🌫️",
                title=f"Air Quality Report: {total_lint} lints, {fmt_drift_count} format drifts",
                detail=(
                    f"Densest smog over `{worst_lint.file_path}` "
                    f"({worst_lint.lint_issue_count} issues)."
                ),
                target_path=worst_lint.file_path,
            )
        )

    greenbelt_pct = round(test_ratio * 100)
    alerts.append(
        AdvisorAlert(
            severity="info" if greenbelt_pct >= 15 else "warn",
            icon="🌳",
            title=f"Greenbelt Ratio: {greenbelt_pct}% test park coverage",
            detail=f"{len(districts)} zoned neighborhoods mapped across the city.",
        )
    )
    return alerts[:5]

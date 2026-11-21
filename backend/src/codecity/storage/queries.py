"""DuckDB 2.0 analytical SQL queries: recursive blast radius, tour landmarks, hotspots & health."""

from __future__ import annotations

import json
from typing import Any

import duckdb

from codecity.models import (
    AdvisorAlert,
    Annotation,
    BlastRadiusNode,
    BlastRadiusResult,
    BuildingArchetype,
    CochangePair,
    District,
    ExternalDep,
    FileImport,
    FileMetric,
    LintDiagnostic,
    Snapshot,
    ZoneType,
)
from codecity.storage.lakehouse import LakehouseManager


def _parse_json(raw: Any, fallback: Any) -> Any:
    if raw is None:
        return fallback
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return fallback
    return raw


def query_snapshots(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
) -> list[Snapshot]:
    pfx = lake.schema_prefix(owner, repo)
    rows = con.execute(
        f"""
        SELECT
            snapshot_idx,
            commit_sha,
            committed_at,
            git_tag,
            total_files,
            total_sloc,
            total_lint_issues,
            to_json(language_breakdown)::VARCHAR,
            health_score,
            health_grade,
            city_archetype_title,
            to_json(advisor_alerts)::VARCHAR
        FROM {pfx}.snapshots
        ORDER BY snapshot_idx ASC;
        """
    ).fetchall()
    out: list[Snapshot] = []
    for r in rows:
        alerts_raw = _parse_json(r[11], [])
        out.append(
            Snapshot(
                snapshot_idx=int(r[0]),
                commit_sha=str(r[1]),
                committed_at=r[2],
                git_tag=str(r[3]) if r[3] is not None else None,
                total_files=int(r[4]),
                total_sloc=int(r[5]),
                total_lint_issues=int(r[6]),
                language_breakdown=_parse_json(r[7], {}),
                health_score=float(r[8]),
                health_grade=str(r[9]),
                city_archetype_title=str(r[10]),
                advisor_alerts=[AdvisorAlert(**a) for a in alerts_raw],
            )
        )
    return out


def query_snapshot_bundle(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
    snapshot_idx: int,
) -> dict[str, Any]:
    pfx = lake.schema_prefix(owner, repo)
    snaps = query_snapshots(con, lake, owner, repo)
    snap = next((s for s in snaps if s.snapshot_idx == snapshot_idx), None)
    if snap is None:
        raise KeyError(f"Snapshot {snapshot_idx} not found for {owner}/{repo}")

    dist_rows = con.execute(
        f"""
        SELECT snapshot_idx, district_path, display_name, zone_type,
               bounds_x, bounds_z, bounds_w, bounds_d,
               file_count, avg_health, summary_blurb
        FROM {pfx}.districts
        WHERE snapshot_idx = ?
        ORDER BY district_path;
        """,
        [snapshot_idx],
    ).fetchall()
    districts = [
        District(
            snapshot_idx=int(r[0]),
            district_path=str(r[1]),
            display_name=str(r[2]),
            zone_type=ZoneType(str(r[3])),
            bounds_x=float(r[4]),
            bounds_z=float(r[5]),
            bounds_w=float(r[6]),
            bounds_d=float(r[7]),
            file_count=int(r[8]),
            avg_health=float(r[9]),
            summary_blurb=str(r[10]),
        )
        for r in dist_rows
    ]

    file_rows = con.execute(
        f"""
        SELECT snapshot_idx, file_path, district_path, language, zone_type,
               building_archetype, role_confidence, to_json(role_signals)::VARCHAR,
               sloc, symbol_count, max_complexity, type_or_doc_ratio,
               lint_issue_count, format_drift, to_json(lint_by_category)::VARCHAR,
               churn_90d, bugfix_commits_90d, distinct_authors_90d, hotspot_score,
               to_json(condition_flags)::VARCHAR,
               layout_x, layout_z, layout_w, layout_d
        FROM {pfx}.file_metrics
        WHERE snapshot_idx = ?
        ORDER BY file_path;
        """,
        [snapshot_idx],
    ).fetchall()
    files = [
        FileMetric(
            snapshot_idx=int(r[0]),
            file_path=str(r[1]),
            district_path=str(r[2]),
            language=str(r[3]),
            zone_type=ZoneType(str(r[4])),
            building_archetype=BuildingArchetype(str(r[5])),
            role_confidence=float(r[6]),
            role_signals=_parse_json(r[7], {}),
            sloc=int(r[8]),
            symbol_count=int(r[9]),
            max_complexity=int(r[10]),
            type_or_doc_ratio=float(r[11]),
            lint_issue_count=int(r[12]),
            format_drift=bool(r[13]),
            lint_by_category=_parse_json(r[14], {}),
            churn_90d=int(r[15]),
            bugfix_commits_90d=int(r[16]),
            distinct_authors_90d=int(r[17]),
            hotspot_score=float(r[18]),
            condition_flags=_parse_json(r[19], {}),
            layout_x=float(r[20]),
            layout_z=float(r[21]),
            layout_w=float(r[22]),
            layout_d=float(r[23]),
        )
        for r in file_rows
    ]

    imp_rows = con.execute(
        f"SELECT snapshot_idx, source_file, target_file FROM {pfx}.file_imports "
        "WHERE snapshot_idx = ?;",
        [snapshot_idx],
    ).fetchall()
    imports = [
        FileImport(snapshot_idx=int(r[0]), source_file=str(r[1]), target_file=str(r[2]))
        for r in imp_rows
    ]

    co_rows = con.execute(
        f"SELECT snapshot_idx, file_a, file_b, shared_commits, coupling_ratio "
        f"FROM {pfx}.cochange_pairs WHERE snapshot_idx = ? ORDER BY coupling_ratio DESC;",
        [snapshot_idx],
    ).fetchall()
    cochanges = [
        CochangePair(
            snapshot_idx=int(r[0]),
            file_a=str(r[1]),
            file_b=str(r[2]),
            shared_commits=int(r[3]),
            coupling_ratio=float(r[4]),
        )
        for r in co_rows
    ]

    dep_rows = con.execute(
        f"SELECT snapshot_idx, ecosystem, package_name, version, is_direct, parent_package "
        f"FROM {pfx}.external_deps WHERE snapshot_idx = ? "
        "ORDER BY is_direct DESC, package_name ASC;",
        [snapshot_idx],
    ).fetchall()
    deps = [
        ExternalDep(
            snapshot_idx=int(r[0]),
            ecosystem=str(r[1]),
            package_name=str(r[2]),
            version=str(r[3]),
            is_direct=bool(r[4]),
            parent_package=str(r[5]) if r[5] is not None else None,
        )
        for r in dep_rows
    ]

    return {
        "snapshot": snap,
        "districts": districts,
        "files": files,
        "imports": imports,
        "cochanges": cochanges,
        "deps": deps,
    }


def query_blast_radius(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
    snapshot_idx: int,
    source_file: str,
) -> BlastRadiusResult:
    """Compute Power-Outage Blast Radius via DuckDB 2.0 recursive CTE + co-change fault lines."""
    pfx = lake.schema_prefix(owner, repo)
    rows = con.execute(
        f"""
        WITH RECURSIVE impacted(file_path, hop_distance, visited) AS (
            SELECT source_file, 1, [target_file, source_file]
            FROM {pfx}.file_imports
            WHERE snapshot_idx = ? AND target_file = ?
            UNION ALL
            SELECT fi.source_file, i.hop_distance + 1, list_append(i.visited, fi.source_file)
            FROM {pfx}.file_imports fi
            JOIN impacted i ON fi.target_file = i.file_path
            WHERE fi.snapshot_idx = ?
              AND i.hop_distance < 6
              AND NOT list_contains(i.visited, fi.source_file)
        ),
        dedup AS (
            SELECT file_path, MIN(hop_distance) AS hop_distance
            FROM impacted
            WHERE file_path != ?
            GROUP BY file_path
        )
        SELECT d.file_path, d.hop_distance, fm.district_path, fm.building_archetype
        FROM dedup d
        JOIN {pfx}.file_metrics fm
          ON fm.snapshot_idx = ? AND fm.file_path = d.file_path
        ORDER BY d.hop_distance ASC, fm.hotspot_score DESC;
        """,
        [snapshot_idx, source_file, snapshot_idx, source_file, snapshot_idx],
    ).fetchall()

    impacted = [
        BlastRadiusNode(
            file_path=str(r[0]),
            hop_distance=int(r[1]),
            district_path=str(r[2]),
            building_archetype=BuildingArchetype(str(r[3])),
        )
        for r in rows
    ]

    co_rows = con.execute(
        f"""
        SELECT snapshot_idx, file_a, file_b, shared_commits, coupling_ratio
        FROM {pfx}.cochange_pairs
        WHERE snapshot_idx = ? AND (file_a = ? OR file_b = ?)
        ORDER BY coupling_ratio DESC, shared_commits DESC
        LIMIT 15;
        """,
        [snapshot_idx, source_file, source_file],
    ).fetchall()
    fault_lines = [
        CochangePair(
            snapshot_idx=int(r[0]),
            file_a=str(r[1]),
            file_b=str(r[2]),
            shared_commits=int(r[3]),
            coupling_ratio=float(r[4]),
        )
        for r in co_rows
    ]

    return BlastRadiusResult(
        source_file=source_file,
        snapshot_idx=snapshot_idx,
        impacted_files=impacted,
        fault_lines=fault_lines,
    )


def query_tour_landmarks(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
    snapshot_idx: int,
) -> list[dict[str, Any]]:
    """Select the 5 canonical Mayor's Guided Tour stops for onboarding in minutes."""
    pfx = lake.schema_prefix(owner, repo)
    rows = con.execute(
        f"""
        SELECT
            file_path,
            district_path,
            zone_type,
            building_archetype,
            sloc,
            max_complexity,
            churn_90d,
            hotspot_score,
            lint_issue_count,
            layout_x,
            layout_z,
            layout_w,
            layout_d
        FROM {pfx}.file_metrics
        WHERE snapshot_idx = ?
        ORDER BY sloc DESC;
        """,
        [snapshot_idx],
    ).fetchall()
    if not rows:
        return []

    items = [
        {
            "file_path": str(r[0]),
            "district_path": str(r[1]),
            "zone_type": str(r[2]),
            "building_archetype": str(r[3]),
            "sloc": int(r[4]),
            "max_complexity": int(r[5]),
            "churn_90d": int(r[6]),
            "hotspot_score": float(r[7]),
            "lint_issue_count": int(r[8]),
            "layout_x": float(r[9]),
            "layout_z": float(r[10]),
            "layout_w": float(r[11]),
            "layout_d": float(r[12]),
        }
        for r in rows
    ]

    picked: list[dict[str, Any]] = []
    used: set[str] = set()

    def pick_stop(
        title: str,
        subtitle: str,
        candidates: list[dict[str, Any]],
        fallback_list: list[dict[str, Any]],
        narration_fn: Any,
    ) -> None:
        pool = [c for c in candidates if c["file_path"] not in used] or [
            c for c in fallback_list if c["file_path"] not in used
        ]
        if not pool:
            return
        target = pool[0]
        used.add(target["file_path"])
        picked.append(
            {
                "step": len(picked) + 1,
                "title": title,
                "subtitle": subtitle,
                "narration": narration_fn(target),
                **target,
            }
        )

    pick_stop(
        "Harbor & City Gate",
        "Where requests and CLI traffic enter the city",
        sorted(
            [i for i in items if i["building_archetype"] == "grand_terminal"],
            key=lambda i: (-i["sloc"], i["file_path"]),
        ),
        items,
        lambda i: (
            f"Start at `{i['file_path']}` in `{i['district_path']}/` — "
            f"an entrypoint handling external requests ({i['sloc']} SLOC)."
        ),
    )
    pick_stop(
        "Downtown City Hall",
        "Core architectural hub & central orchestrator",
        sorted(
            [i for i in items if i["building_archetype"] in {"city_hall", "office_tower"}],
            key=lambda i: (-i["sloc"], -i["max_complexity"]),
        ),
        items,
        lambda i: (
            f"`{i['file_path']}` anchors the core logic district with {i['sloc']} SLOC "
            f"and max branching depth {i['max_complexity']}."
        ),
    )
    pick_stop(
        "Vaults & Reservoir",
        "Schemas, models, and persistent state",
        sorted(
            [i for i in items if i["building_archetype"] in {"twin_silos", "archive_vault"}],
            key=lambda i: -i["sloc"],
        ),
        items,
        lambda i: (
            f"`{i['file_path']}` safeguards data models and storage contracts ({i['sloc']} SLOC)."
        ),
    )
    pick_stop(
        "Active Construction Zone",
        "Highest 90-day churn & refactor hotspot",
        sorted(items, key=lambda i: (-i["hotspot_score"], -i["churn_90d"])),
        items,
        lambda i: (
            f"Hardhats required at `{i['file_path']}` — {i['churn_90d']} churn weight "
            f"and hotspot score {i['hotspot_score']:.1f}."
        ),
    )
    pick_stop(
        "Greenbelt Proving Parks",
        "Automated test suites protecting the skyline",
        sorted(
            [i for i in items if i["building_archetype"] == "park_stadium"],
            key=lambda i: -i["sloc"],
        ),
        items,
        lambda i: f"`{i['file_path']}` anchors verification in the Greenbelt ({i['sloc']} SLOC).",
    )
    return picked


def query_health_report(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
    snapshot_idx: int,
) -> dict[str, Any]:
    """Assemble the shareable OSS Repo Health Report Card payload."""
    pfx = lake.schema_prefix(owner, repo)
    snaps = query_snapshots(con, lake, owner, repo)
    snap = next((s for s in snaps if s.snapshot_idx == snapshot_idx), snaps[-1])

    hotspots = con.execute(
        f"""
        SELECT file_path, district_path, building_archetype, hotspot_score,
               churn_90d, lint_issue_count, max_complexity, distinct_authors_90d
        FROM {pfx}.file_metrics
        WHERE snapshot_idx = ?
        ORDER BY hotspot_score DESC, lint_issue_count DESC
        LIMIT 8;
        """,
        [snap.snapshot_idx],
    ).fetchall()

    lone_count_row = con.execute(
        f"""
        SELECT COUNT(*)
        FROM {pfx}.file_metrics
        WHERE snapshot_idx = ? AND distinct_authors_90d = 1 AND sloc >= 40;
        """,
        [snap.snapshot_idx],
    ).fetchone()
    test_sloc_row = con.execute(
        f"""
        SELECT COALESCE(SUM(sloc), 0)
        FROM {pfx}.file_metrics
        WHERE snapshot_idx = ? AND building_archetype = 'park_stadium';
        """,
        [snap.snapshot_idx],
    ).fetchone()

    test_sloc = int(test_sloc_row[0]) if test_sloc_row else 0
    greenbelt_pct = round(100.0 * test_sloc / max(1, snap.total_sloc), 1)
    return {
        "owner": owner,
        "repo": repo,
        "snapshot_idx": snap.snapshot_idx,
        "commit_sha": snap.commit_sha,
        "git_tag": snap.git_tag,
        "health_score": snap.health_score,
        "health_grade": snap.health_grade,
        "city_archetype_title": snap.city_archetype_title,
        "total_files": snap.total_files,
        "total_sloc": snap.total_sloc,
        "total_lint_issues": snap.total_lint_issues,
        "greenbelt_pct": greenbelt_pct,
        "lone_keeper_files": int(lone_count_row[0]) if lone_count_row else 0,
        "language_breakdown": snap.language_breakdown,
        "advisor_alerts": [a.model_dump() for a in snap.advisor_alerts],
        "top_hotspots": [
            {
                "file_path": str(r[0]),
                "district_path": str(r[1]),
                "building_archetype": str(r[2]),
                "hotspot_score": float(r[3]),
                "churn_90d": int(r[4]),
                "lint_issue_count": int(r[5]),
                "max_complexity": int(r[6]),
                "distinct_authors_90d": int(r[7]),
            }
            for r in hotspots
        ],
    }


def query_file_history(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
    file_path: str,
) -> list[dict[str, Any]]:
    pfx = lake.schema_prefix(owner, repo)
    rows = con.execute(
        f"""
        SELECT snapshot_idx, sloc, max_complexity, churn_90d, hotspot_score, lint_issue_count
        FROM {pfx}.file_metrics
        WHERE file_path = ?
        ORDER BY snapshot_idx ASC;
        """,
        [file_path],
    ).fetchall()
    return [
        {
            "snapshot_idx": int(r[0]),
            "sloc": int(r[1]),
            "max_complexity": int(r[2]),
            "churn_90d": int(r[3]),
            "hotspot_score": float(r[4]),
            "lint_issue_count": int(r[5]),
        }
        for r in rows
    ]


def query_file_diagnostics(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
    snapshot_idx: int,
    file_path: str,
) -> list[LintDiagnostic]:
    pfx = lake.schema_prefix(owner, repo)
    rows = con.execute(
        f"""
        SELECT snapshot_idx, file_path, linter, line, col, rule_code,
               category, message, fixable, to_json(metadata)::VARCHAR
        FROM {pfx}.lint_diagnostics
        WHERE snapshot_idx = ? AND file_path = ?
        ORDER BY line ASC, col ASC
        LIMIT 100;
        """,
        [snapshot_idx, file_path],
    ).fetchall()
    return [
        LintDiagnostic(
            snapshot_idx=int(r[0]),
            file_path=str(r[1]),
            linter=str(r[2]),
            line=int(r[3]),
            col=int(r[4]),
            rule_code=str(r[5]),
            category=str(r[6]),
            message=str(r[7]),
            fixable=bool(r[8]),
            metadata=_parse_json(r[9], {}),
        )
        for r in rows
    ]


def query_annotations(
    con: duckdb.DuckDBPyConnection,
    lake: LakehouseManager,
    owner: str,
    repo: str,
) -> list[Annotation]:
    pfx = lake.schema_prefix(owner, repo)
    rows = con.execute(
        f"""
        SELECT annotation_id, file_path, author, tag, body, created_at
        FROM {pfx}.annotations
        ORDER BY created_at DESC;
        """
    ).fetchall()
    return [
        Annotation(
            annotation_id=str(r[0]),
            file_path=str(r[1]),
            author=str(r[2]),
            tag=str(r[3]),
            body=str(r[4]),
            created_at=r[5],
        )
        for r in rows
    ]

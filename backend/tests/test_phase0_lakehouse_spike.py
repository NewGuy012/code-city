"""Phase 0 Risk Spike: DuckDB 2.0 + DuckLake 1.1 + Quack concurrent multi-writer verification."""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from codecity.models import (
    AdvisorAlert,
    Annotation,
    BuildingArchetype,
    District,
    FileMetric,
    Snapshot,
    ZoneType,
)
from codecity.storage import LakehouseManager, QuackServerManager


def test_ducklake_nested_schema_quack_multiwriter_and_parquet_export(tmp_path: Path) -> None:
    lake = LakehouseManager(data_dir=tmp_path / "codecity_data")
    with lake.session() as con:
        schema_dot = lake.ensure_repo_schema(con, "acme-org", "demo-app", "/tmp/demo-app")
        assert schema_dot == "repos.acme_org.demo_app"

    errors: list[tuple[int, Exception]] = []

    with QuackServerManager(lake) as qsrv:
        assert qsrv.endpoint is not None

        def worker(idx: int) -> None:
            try:
                client = qsrv.connect_client(alias="remote")
                try:
                    snap = Snapshot(
                        snapshot_idx=idx,
                        commit_sha=f"deadbeef{idx:04d}",
                        committed_at=datetime(2026, 1, 1 + idx, tzinfo=UTC),
                        git_tag=f"v0.{idx}.0" if idx == 0 else None,
                        total_files=1,
                        total_sloc=120 + idx * 10,
                        total_lint_issues=idx,
                        language_breakdown={"python": 1},
                        health_score=92.5 - idx,
                        health_grade="A",
                        city_archetype_title="Sunlit Civic Metropolis",
                        advisor_alerts=[
                            AdvisorAlert(
                                severity="info",
                                icon="🏗️",
                                title="Steady Growth",
                                detail="Core module healthy",
                                target_path="src/app.py",
                            )
                        ],
                    )
                    dist = District(
                        snapshot_idx=idx,
                        district_path="src",
                        display_name="src",
                        zone_type=ZoneType.DOWNTOWN_CORE,
                        bounds_x=0.0,
                        bounds_z=0.0,
                        bounds_w=20.0,
                        bounds_d=20.0,
                        file_count=1,
                        avg_health=92.0,
                        summary_blurb="Core engine",
                    )
                    fm = FileMetric(
                        snapshot_idx=idx,
                        file_path="src/app.py",
                        district_path="src",
                        language="python",
                        zone_type=ZoneType.DOWNTOWN_CORE,
                        building_archetype=BuildingArchetype.CITY_HALL,
                        role_confidence=0.95,
                        role_signals={"fan_in": 12},
                        sloc=120 + idx * 10,
                        symbol_count=6,
                        max_complexity=4,
                        type_or_doc_ratio=0.9,
                        lint_issue_count=idx,
                        format_drift=False,
                        lint_by_category={"style": idx},
                        churn_90d=5 + idx,
                        bugfix_commits_90d=0,
                        distinct_authors_90d=2,
                        hotspot_score=1.5 + idx,
                        condition_flags={"crane": idx >= 2},
                        layout_x=2.0,
                        layout_z=2.0,
                        layout_w=6.0,
                        layout_d=6.0,
                    )
                    lake.write_snapshot_bundle(
                        client,
                        "acme-org",
                        "demo-app",
                        snap,
                        [dist],
                        [fm],
                        [],
                        [],
                        [],
                        [],
                        catalog_prefix="remote.lake",
                    )
                finally:
                    client.close()
            except Exception as exc:  # pragma: no cover - captured for assertion
                errors.append((idx, exc))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []

        # Write collaborative Mayor annotation over Quack and verify table_changes()
        ann_client = qsrv.connect_client(alias="remote")
        try:
            lake.add_annotation(
                ann_client,
                "acme-org",
                "demo-app",
                Annotation(
                    annotation_id="note-1",
                    file_path="src/app.py",
                    author="mayor",
                    tag="refactor",
                    body="Split router handlers next sprint",
                    created_at=datetime(2026, 2, 1, tzinfo=UTC),
                ),
                catalog_prefix="remote.lake",
            )
        finally:
            ann_client.close()

    with lake.session(read_only=True) as con:
        pfx = lake.schema_prefix("acme-org", "demo-app")
        snaps = con.execute(
            f"SELECT COUNT(*), MIN(snapshot_idx), MAX(snapshot_idx) FROM {pfx}.snapshots"
        ).fetchone()
        assert snaps == (4, 0, 3)

        changes = lake.get_annotation_changes(con, "acme-org", "demo-app")
        assert len(changes) == 1
        assert changes[0]["annotation_id"] == "note-1"
        assert changes[0]["author"] == "mayor"

        export_dir = tmp_path / "static_parquet"
        exported = lake.export_repo_parquet(con, "acme-org", "demo-app", export_dir)
        assert set(exported.keys()) == {
            "snapshots",
            "districts",
            "file_metrics",
            "file_imports",
            "cochange_pairs",
            "external_deps",
            "lint_diagnostics",
            "annotations",
        }

        plain = duckdb.connect()
        try:
            pq_path = exported["snapshots"]
            cnt = plain.execute(
                f"SELECT COUNT(*), MIN(language_breakdown) FROM read_parquet('{pq_path}')"
            ).fetchone()
            assert cnt is not None
            assert cnt[0] == 4
            assert '"python":1' in cnt[1]
        finally:
            plain.close()

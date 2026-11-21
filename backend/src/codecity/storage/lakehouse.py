"""DuckDB 2.0 + DuckLake 1.1 nested schema lakehouse manager."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb
import polars as pl

from codecity.models import (
    Annotation,
    CochangePair,
    District,
    ExternalDep,
    FileImport,
    FileMetric,
    LintDiagnostic,
    RepoRef,
    Snapshot,
)

DEFAULT_CATALOG_NAME = "lake"
DATA_INLINING_LIMIT = 1000

TABLE_NAMES = (
    "snapshots",
    "districts",
    "file_metrics",
    "file_imports",
    "cochange_pairs",
    "external_deps",
    "lint_diagnostics",
    "annotations",
)


def default_data_dir() -> Path:
    """Resolve the local DuckLake data directory from environment or cwd."""
    env_dir = os.environ.get("CODECITY_DATA_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()
    return (Path.cwd() / ".codecity").resolve()


def sanitize_identifier(raw: str) -> str:
    """Convert an arbitrary owner/repo string into a safe DuckDB SQL identifier."""
    cleaned = re.sub(r"[^a-zA-Z0-9_]", "_", raw.strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not cleaned:
        cleaned = "repo"
    if cleaned[0].isdigit():
        cleaned = f"r_{cleaned}"
    return cleaned


def quote_ident(ident: str) -> str:
    """Quote a SQL identifier safely."""
    escaped = ident.replace('"', '""')
    return f'"{escaped}"'


def quote_catalog_prefix(prefix: str) -> str:
    """Quote a single or dotted catalog prefix (e.g. `lake` or `remote.lake`)."""
    return ".".join(quote_ident(part) for part in prefix.split(".") if part)


def infer_owner_repo(
    source: str,
    owner: str | None = None,
    repo: str | None = None,
) -> tuple[str, str]:
    """Derive clean (owner, repo) identifiers from a local path or Git URL."""
    if owner and repo:
        return sanitize_identifier(owner), sanitize_identifier(repo)

    cleaned = source.strip().rstrip("/")
    if cleaned.endswith(".git"):
        cleaned = cleaned[:-4]

    if "://" in cleaned or cleaned.startswith("git@"):
        parts = re.split(r"[/:]", cleaned)
        parts = [p for p in parts if p]
        inferred_repo = parts[-1] if parts else "repo"
        inferred_owner = parts[-2] if len(parts) >= 2 else "git"
    else:
        path = Path(cleaned).expanduser().resolve()
        inferred_repo = path.name or "repo"
        inferred_owner = path.parent.name or "local"

    return (
        sanitize_identifier(owner or inferred_owner),
        sanitize_identifier(repo or inferred_repo),
    )


class LakehouseManager:
    """Manages DuckLake 1.1 catalog, nested repo schemas, and Parquet exports."""

    def __init__(
        self,
        data_dir: Path | None = None,
        catalog_name: str = DEFAULT_CATALOG_NAME,
    ) -> None:
        self.data_dir = (data_dir or default_data_dir()).resolve()
        self.catalog_path = self.data_dir / "metadata.ducklake"
        self.parquet_dir = self.data_dir / "lake_data"
        self.catalog_name = catalog_name
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.parquet_dir.mkdir(parents=True, exist_ok=True)

    def connect(self, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        """Open a DuckDB 2.0 connection with DuckLake 1.1 and Quack extensions attached."""
        con = duckdb.connect()
        self._load_extensions(con)
        attach_opts = [
            f"DATA_PATH '{self._escape_sql_literal(str(self.parquet_dir))}'",
            "AUTOMATIC_MIGRATION true",
            f"DATA_INLINING_ROW_LIMIT {DATA_INLINING_LIMIT}",
        ]
        if read_only:
            attach_opts.append("READ_ONLY")
        opts_sql = ", ".join(attach_opts)
        cat_literal = self._escape_sql_literal(str(self.catalog_path))
        cat_q = quote_ident(self.catalog_name)
        con.execute(f"ATTACH 'ducklake:{cat_literal}' AS {cat_q} ({opts_sql});")
        if not read_only:
            self._ensure_root_registry(con)
        return con

    @contextmanager
    def session(self, *, read_only: bool = False) -> Iterator[duckdb.DuckDBPyConnection]:
        """Context-managed DuckDB connection attached to the DuckLake catalog."""
        con = self.connect(read_only=read_only)
        try:
            yield con
        finally:
            con.close()

    @staticmethod
    def _load_extensions(con: duckdb.DuckDBPyConnection) -> None:
        for ext in ("ducklake", "quack"):
            try:
                con.execute(f"LOAD {ext};")
            except duckdb.Error:
                con.execute(f"INSTALL {ext}; LOAD {ext};")

    @staticmethod
    def _escape_sql_literal(value: str) -> str:
        return value.replace("'", "''")

    def _ensure_root_registry(self, con: duckdb.DuckDBPyConnection) -> None:
        cat = quote_ident(self.catalog_name)
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos;")
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {cat}.repos.repo_registry (
                owner VARCHAR,
                repo VARCHAR,
                schema_path VARCHAR,
                source VARCHAR,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            """
        )

    def schema_prefix(self, owner: str, repo: str, *, catalog_prefix: str | None = None) -> str:
        """Return qualified `catalog.repos.owner.repo` SQL prefix."""
        o = sanitize_identifier(owner)
        r = sanitize_identifier(repo)
        cat = quote_catalog_prefix(catalog_prefix or self.catalog_name)
        return f"{cat}.repos.{quote_ident(o)}.{quote_ident(r)}"

    def schema_dot_path(self, owner: str, repo: str) -> str:
        """Return DuckLake schema string (`repos.<owner>.<repo>`)."""
        return f"repos.{sanitize_identifier(owner)}.{sanitize_identifier(repo)}"

    def ensure_repo_schema(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        source: str,
        *,
        catalog_prefix: str | None = None,
    ) -> str:
        """Create nested DuckLake 1.1 schemas `repos.<owner>.<repo>` and all 8 tables."""
        o = sanitize_identifier(owner)
        r = sanitize_identifier(repo)
        cat = quote_catalog_prefix(catalog_prefix or self.catalog_name)
        schema_dot = self.schema_dot_path(o, r)

        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos;")
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos.{quote_ident(o)};")
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos.{quote_ident(o)}.{quote_ident(r)};")

        pfx = self.schema_prefix(o, r, catalog_prefix=catalog_prefix)
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.snapshots (
                snapshot_idx INTEGER,
                commit_sha VARCHAR,
                committed_at TIMESTAMP,
                git_tag VARCHAR,
                total_files INTEGER,
                total_sloc INTEGER,
                total_lint_issues INTEGER,
                language_breakdown VARIANT,
                health_score DOUBLE,
                health_grade VARCHAR,
                city_archetype_title VARCHAR,
                advisor_alerts VARIANT
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.districts (
                snapshot_idx INTEGER,
                district_path VARCHAR,
                display_name VARCHAR,
                zone_type VARCHAR,
                bounds_x DOUBLE,
                bounds_z DOUBLE,
                bounds_w DOUBLE,
                bounds_d DOUBLE,
                file_count INTEGER,
                avg_health DOUBLE,
                summary_blurb VARCHAR
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.file_metrics (
                snapshot_idx INTEGER,
                file_path VARCHAR,
                district_path VARCHAR,
                language VARCHAR,
                zone_type VARCHAR,
                building_archetype VARCHAR,
                role_confidence DOUBLE,
                role_signals VARIANT,
                sloc INTEGER,
                symbol_count INTEGER,
                max_complexity INTEGER,
                type_or_doc_ratio DOUBLE,
                lint_issue_count INTEGER,
                format_drift BOOLEAN,
                lint_by_category VARIANT,
                churn_90d INTEGER,
                bugfix_commits_90d INTEGER,
                distinct_authors_90d INTEGER,
                hotspot_score DOUBLE,
                condition_flags VARIANT,
                layout_x DOUBLE,
                layout_z DOUBLE,
                layout_w DOUBLE,
                layout_d DOUBLE
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.file_imports (
                snapshot_idx INTEGER,
                source_file VARCHAR,
                target_file VARCHAR
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.cochange_pairs (
                snapshot_idx INTEGER,
                file_a VARCHAR,
                file_b VARCHAR,
                shared_commits INTEGER,
                coupling_ratio DOUBLE
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.external_deps (
                snapshot_idx INTEGER,
                ecosystem VARCHAR,
                package_name VARCHAR,
                version VARCHAR,
                is_direct BOOLEAN,
                parent_package VARCHAR
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.lint_diagnostics (
                snapshot_idx INTEGER,
                file_path VARCHAR,
                linter VARCHAR,
                line INTEGER,
                col INTEGER,
                rule_code VARCHAR,
                category VARCHAR,
                message VARCHAR,
                fixable BOOLEAN,
                metadata VARIANT
            );
            """
        )
        con.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {pfx}.annotations (
                annotation_id VARCHAR,
                file_path VARCHAR,
                author VARCHAR,
                tag VARCHAR,
                body VARCHAR,
                created_at TIMESTAMP
            );
            """
        )

        now = datetime.now(UTC).replace(tzinfo=None)
        existing = con.execute(
            f"SELECT COUNT(*) FROM {cat}.repos.repo_registry WHERE owner = ? AND repo = ?",
            [o, r],
        ).fetchone()
        if existing and existing[0] > 0:
            con.execute(
                f"UPDATE {cat}.repos.repo_registry SET source = ?, updated_at = ? "
                "WHERE owner = ? AND repo = ?",
                [source, now, o, r],
            )
        else:
            con.execute(
                f"INSERT INTO {cat}.repos.repo_registry VALUES (?, ?, ?, ?, ?, ?)",
                [o, r, schema_dot, source, now, now],
            )
        return schema_dot

    def clear_repo_analysis_data(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        *,
        preserve_annotations: bool = True,
        catalog_prefix: str | None = None,
    ) -> None:
        """Clear prior snapshots/metrics before re-indexing while keeping Mayor notes if set."""
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        for tbl in TABLE_NAMES:
            if preserve_annotations and tbl == "annotations":
                continue
            con.execute(f"DELETE FROM {pfx}.{tbl};")

    def write_snapshot_bundle(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        snapshot: Snapshot,
        districts: list[District],
        files: list[FileMetric],
        imports: list[FileImport],
        cochanges: list[CochangePair],
        deps: list[ExternalDep],
        diagnostics: list[LintDiagnostic],
        *,
        catalog_prefix: str | None = None,
    ) -> None:
        """Bulk-write one keyframe's records into DuckLake (supports remote Quack catalogs)."""
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)

        snap_df = pl.DataFrame(
            [
                {
                    "snapshot_idx": snapshot.snapshot_idx,
                    "commit_sha": snapshot.commit_sha,
                    "committed_at": snapshot.committed_at.replace(tzinfo=None),
                    "git_tag": snapshot.git_tag,
                    "total_files": snapshot.total_files,
                    "total_sloc": snapshot.total_sloc,
                    "total_lint_issues": snapshot.total_lint_issues,
                    "language_breakdown": json.dumps(snapshot.language_breakdown),
                    "health_score": float(snapshot.health_score),
                    "health_grade": snapshot.health_grade,
                    "city_archetype_title": snapshot.city_archetype_title,
                    "advisor_alerts": json.dumps([a.model_dump() for a in snapshot.advisor_alerts]),
                }
            ],
            schema={
                "snapshot_idx": pl.Int32,
                "commit_sha": pl.String,
                "committed_at": pl.Datetime("us"),
                "git_tag": pl.String,
                "total_files": pl.Int32,
                "total_sloc": pl.Int32,
                "total_lint_issues": pl.Int32,
                "language_breakdown": pl.String,
                "health_score": pl.Float64,
                "health_grade": pl.String,
                "city_archetype_title": pl.String,
                "advisor_alerts": pl.String,
            },
        )
        con.register("_tmp_snap", snap_df)
        con.execute(
            f"""
            INSERT INTO {pfx}.snapshots
            SELECT
                snapshot_idx,
                commit_sha,
                committed_at,
                git_tag,
                total_files,
                total_sloc,
                total_lint_issues,
                language_breakdown::JSON::VARIANT,
                health_score,
                health_grade,
                city_archetype_title,
                advisor_alerts::JSON::VARIANT
            FROM _tmp_snap;
            """
        )

        if districts:
            dist_df = pl.DataFrame(
                [
                    {
                        "snapshot_idx": d.snapshot_idx,
                        "district_path": d.district_path,
                        "display_name": d.display_name,
                        "zone_type": d.zone_type.value,
                        "bounds_x": float(d.bounds_x),
                        "bounds_z": float(d.bounds_z),
                        "bounds_w": float(d.bounds_w),
                        "bounds_d": float(d.bounds_d),
                        "file_count": d.file_count,
                        "avg_health": float(d.avg_health),
                        "summary_blurb": d.summary_blurb,
                    }
                    for d in districts
                ]
            )
            con.register("_tmp_dist", dist_df)
            con.execute(f"INSERT INTO {pfx}.districts SELECT * FROM _tmp_dist;")

        if files:
            files_df = pl.DataFrame(
                [
                    {
                        "snapshot_idx": f.snapshot_idx,
                        "file_path": f.file_path,
                        "district_path": f.district_path,
                        "language": f.language,
                        "zone_type": f.zone_type.value,
                        "building_archetype": f.building_archetype.value,
                        "role_confidence": float(f.role_confidence),
                        "role_signals": json.dumps(f.role_signals),
                        "sloc": f.sloc,
                        "symbol_count": f.symbol_count,
                        "max_complexity": f.max_complexity,
                        "type_or_doc_ratio": float(f.type_or_doc_ratio),
                        "lint_issue_count": f.lint_issue_count,
                        "format_drift": bool(f.format_drift),
                        "lint_by_category": json.dumps(f.lint_by_category),
                        "churn_90d": f.churn_90d,
                        "bugfix_commits_90d": f.bugfix_commits_90d,
                        "distinct_authors_90d": f.distinct_authors_90d,
                        "hotspot_score": float(f.hotspot_score),
                        "condition_flags": json.dumps(f.condition_flags),
                        "layout_x": float(f.layout_x),
                        "layout_z": float(f.layout_z),
                        "layout_w": float(f.layout_w),
                        "layout_d": float(f.layout_d),
                    }
                    for f in files
                ]
            )
            con.register("_tmp_files", files_df)
            con.execute(
                f"""
                INSERT INTO {pfx}.file_metrics
                SELECT
                    snapshot_idx,
                    file_path,
                    district_path,
                    language,
                    zone_type,
                    building_archetype,
                    role_confidence,
                    role_signals::JSON::VARIANT,
                    sloc,
                    symbol_count,
                    max_complexity,
                    type_or_doc_ratio,
                    lint_issue_count,
                    format_drift,
                    lint_by_category::JSON::VARIANT,
                    churn_90d,
                    bugfix_commits_90d,
                    distinct_authors_90d,
                    hotspot_score,
                    condition_flags::JSON::VARIANT,
                    layout_x,
                    layout_z,
                    layout_w,
                    layout_d
                FROM _tmp_files;
                """
            )

        if imports:
            imp_df = pl.DataFrame(
                [
                    {
                        "snapshot_idx": i.snapshot_idx,
                        "source_file": i.source_file,
                        "target_file": i.target_file,
                    }
                    for i in imports
                ]
            )
            con.register("_tmp_imp", imp_df)
            con.execute(f"INSERT INTO {pfx}.file_imports SELECT * FROM _tmp_imp;")

        if cochanges:
            co_df = pl.DataFrame(
                [
                    {
                        "snapshot_idx": c.snapshot_idx,
                        "file_a": c.file_a,
                        "file_b": c.file_b,
                        "shared_commits": c.shared_commits,
                        "coupling_ratio": float(c.coupling_ratio),
                    }
                    for c in cochanges
                ]
            )
            con.register("_tmp_co", co_df)
            con.execute(f"INSERT INTO {pfx}.cochange_pairs SELECT * FROM _tmp_co;")

        if deps:
            dep_df = pl.DataFrame(
                [
                    {
                        "snapshot_idx": d.snapshot_idx,
                        "ecosystem": d.ecosystem,
                        "package_name": d.package_name,
                        "version": d.version,
                        "is_direct": bool(d.is_direct),
                        "parent_package": d.parent_package,
                    }
                    for d in deps
                ],
                schema={
                    "snapshot_idx": pl.Int32,
                    "ecosystem": pl.String,
                    "package_name": pl.String,
                    "version": pl.String,
                    "is_direct": pl.Boolean,
                    "parent_package": pl.String,
                },
            )
            con.register("_tmp_deps", dep_df)
            con.execute(f"INSERT INTO {pfx}.external_deps SELECT * FROM _tmp_deps;")

        if diagnostics:
            diag_df = pl.DataFrame(
                [
                    {
                        "snapshot_idx": diag.snapshot_idx,
                        "file_path": diag.file_path,
                        "linter": diag.linter,
                        "line": diag.line,
                        "col": diag.col,
                        "rule_code": diag.rule_code,
                        "category": diag.category,
                        "message": diag.message,
                        "fixable": bool(diag.fixable),
                        "metadata": json.dumps(diag.metadata),
                    }
                    for diag in diagnostics
                ]
            )
            con.register("_tmp_diag", diag_df)
            con.execute(
                f"""
                INSERT INTO {pfx}.lint_diagnostics
                SELECT
                    snapshot_idx,
                    file_path,
                    linter,
                    line,
                    col,
                    rule_code,
                    category,
                    message,
                    fixable,
                    metadata::JSON::VARIANT
                FROM _tmp_diag;
                """
            )

    def add_annotation(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        annotation: Annotation,
        *,
        catalog_prefix: str | None = None,
    ) -> None:
        """Insert a Mayor Note directly into DuckLake (inlined automatically for fast writes)."""
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        df = pl.DataFrame(
            [
                {
                    "annotation_id": annotation.annotation_id,
                    "file_path": annotation.file_path,
                    "author": annotation.author,
                    "tag": annotation.tag,
                    "body": annotation.body,
                    "created_at": annotation.created_at.replace(tzinfo=None),
                }
            ]
        )
        con.register("_tmp_ann", df)
        con.execute(f"INSERT INTO {pfx}.annotations SELECT * FROM _tmp_ann;")

    def get_annotation_changes(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        start_snapshot: int = 0,
    ) -> list[dict[str, Any]]:
        """Query DuckLake `ducklake_table_changes()` for the live Mayor Notes changelog."""
        schema_dot = self.schema_dot_path(owner, repo)
        cat = self._escape_sql_literal(self.catalog_name)
        cur = con.execute(f"SELECT * FROM ducklake_current_snapshot('{cat}')").fetchone()
        if not cur or cur[0] is None:
            return []
        end_snap = int(cur[0])
        if start_snapshot > end_snap:
            return []
        rows = con.execute(
            f"""
            SELECT
                snapshot_id,
                rowid,
                change_type,
                annotation_id,
                file_path,
                author,
                tag,
                body,
                created_at
            FROM ducklake_table_changes(
                '{cat}', '{schema_dot}', 'annotations', {start_snapshot}, {end_snap}
            )
            ORDER BY snapshot_id DESC, created_at DESC;
            """
        ).fetchall()
        cols = [
            "snapshot_id",
            "rowid",
            "change_type",
            "annotation_id",
            "file_path",
            "author",
            "tag",
            "body",
            "created_at",
        ]
        results = []
        for row in rows:
            item = dict(zip(cols, row, strict=True))
            if isinstance(item["created_at"], datetime):
                item["created_at"] = item["created_at"].isoformat()
            results.append(item)
        return results

    def list_repos(self, con: duckdb.DuckDBPyConnection) -> list[RepoRef]:
        """List all analyzed repositories and their latest snapshot summary."""
        cat = quote_ident(self.catalog_name)
        rows = con.execute(
            f"SELECT owner, repo, schema_path, source "
            f"FROM {cat}.repos.repo_registry ORDER BY updated_at DESC;"
        ).fetchall()
        repos: list[RepoRef] = []
        for owner, repo, schema_path, source in rows:
            pfx = self.schema_prefix(owner, repo)
            snap_row = con.execute(
                f"""
                SELECT
                    COUNT(*),
                    COALESCE(MAX(snapshot_idx), 0)
                FROM {pfx}.snapshots;
                """
            ).fetchone()
            total_snaps = int(snap_row[0]) if snap_row else 0
            latest_idx = int(snap_row[1]) if snap_row else 0
            latest_grade = "A"
            latest_title = "Sunlit Civic Metropolis"
            total_files = 0
            if total_snaps > 0:
                meta = con.execute(
                    f"""
                    SELECT health_grade, city_archetype_title, total_files
                    FROM {pfx}.snapshots
                    WHERE snapshot_idx = ?
                    LIMIT 1;
                    """,
                    [latest_idx],
                ).fetchone()
                if meta:
                    latest_grade = str(meta[0])
                    latest_title = str(meta[1])
                    total_files = int(meta[2])
            repos.append(
                RepoRef(
                    owner=owner,
                    repo=repo,
                    schema_path=schema_path,
                    repo_url_or_path=source,
                    latest_snapshot_idx=latest_idx,
                    latest_grade=latest_grade,
                    latest_title=latest_title,
                    total_snapshots=total_snaps,
                    total_files=total_files,
                )
            )
        return repos

    def export_repo_parquet(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        out_dir: Path,
    ) -> dict[str, Path]:
        """Export every table for a repo to DuckDB-Wasm-compatible Parquet files."""
        out_dir.mkdir(parents=True, exist_ok=True)
        pfx = self.schema_prefix(owner, repo)

        projections = {
            "snapshots": (
                "snapshot_idx, commit_sha, committed_at, git_tag, total_files, total_sloc, "
                "total_lint_issues, to_json(language_breakdown)::VARCHAR AS language_breakdown, "
                "health_score, health_grade, city_archetype_title, "
                "to_json(advisor_alerts)::VARCHAR AS advisor_alerts"
            ),
            "districts": "*",
            "file_metrics": (
                "snapshot_idx, file_path, district_path, language, zone_type, building_archetype, "
                "role_confidence, to_json(role_signals)::VARCHAR AS role_signals, "
                "sloc, symbol_count, max_complexity, type_or_doc_ratio, lint_issue_count, "
                "format_drift, to_json(lint_by_category)::VARCHAR AS lint_by_category, "
                "churn_90d, bugfix_commits_90d, distinct_authors_90d, hotspot_score, "
                "to_json(condition_flags)::VARCHAR AS condition_flags, "
                "layout_x, layout_z, layout_w, layout_d"
            ),
            "file_imports": "*",
            "cochange_pairs": "*",
            "external_deps": "*",
            "lint_diagnostics": (
                "snapshot_idx, file_path, linter, line, col, rule_code, category, message, "
                "fixable, to_json(metadata)::VARCHAR AS metadata"
            ),
            "annotations": "*",
        }

        exported: dict[str, Path] = {}
        for tbl, cols_expr in projections.items():
            dest = out_dir / f"{tbl}.parquet"
            dest_esc = self._escape_sql_literal(str(dest))
            con.execute(
                f"COPY (SELECT {cols_expr} FROM {pfx}.{tbl}) TO '{dest_esc}' (FORMAT PARQUET);"
            )
            exported[tbl] = dest
        return exported

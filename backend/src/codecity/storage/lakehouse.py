"""DuckDB 2.0 + DuckLake 1.1 nested schema lakehouse manager."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

import duckdb
from pydantic import BaseModel

from codecity.models import (
    Annotation,
    CochangePair,
    District,
    ExternalDep,
    FileImport,
    FileMetric,
    LintDiagnostic,
    RepoRef,
    SandboxAction,
    Snapshot,
)

DEFAULT_CATALOG_NAME = "lake"
DATA_INLINING_LIMIT = 1000
_ACTION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

_ColumnSpec = tuple[str, str]

_TABLE_SCHEMAS: dict[str, list[_ColumnSpec]] = {
    "snapshots": [
        ("snapshot_idx", "INTEGER"),
        ("commit_sha", "VARCHAR"),
        ("committed_at", "TIMESTAMP"),
        ("git_tag", "VARCHAR"),
        ("total_files", "INTEGER"),
        ("total_sloc", "INTEGER"),
        ("total_lint_issues", "INTEGER"),
        ("language_breakdown", "VARIANT"),
        ("health_score", "DOUBLE"),
        ("health_grade", "VARCHAR"),
        ("city_archetype_title", "VARCHAR"),
        ("advisor_alerts", "VARIANT"),
    ],
    "districts": [
        ("snapshot_idx", "INTEGER"),
        ("district_path", "VARCHAR"),
        ("display_name", "VARCHAR"),
        ("zone_type", "VARCHAR"),
        ("bounds_x", "DOUBLE"),
        ("bounds_z", "DOUBLE"),
        ("bounds_w", "DOUBLE"),
        ("bounds_d", "DOUBLE"),
        ("file_count", "INTEGER"),
        ("avg_health", "DOUBLE"),
        ("summary_blurb", "VARCHAR"),
    ],
    "file_metrics": [
        ("snapshot_idx", "INTEGER"),
        ("file_path", "VARCHAR"),
        ("district_path", "VARCHAR"),
        ("language", "VARCHAR"),
        ("zone_type", "VARCHAR"),
        ("building_archetype", "VARCHAR"),
        ("role_confidence", "DOUBLE"),
        ("role_signals", "VARIANT"),
        ("sloc", "INTEGER"),
        ("symbol_count", "INTEGER"),
        ("max_complexity", "INTEGER"),
        ("type_or_doc_ratio", "DOUBLE"),
        ("lint_issue_count", "INTEGER"),
        ("format_drift", "BOOLEAN"),
        ("lint_by_category", "VARIANT"),
        ("churn_90d", "INTEGER"),
        ("bugfix_commits_90d", "INTEGER"),
        ("distinct_authors_90d", "INTEGER"),
        ("hotspot_score", "DOUBLE"),
        ("condition_flags", "VARIANT"),
        ("layout_x", "DOUBLE"),
        ("layout_z", "DOUBLE"),
        ("layout_w", "DOUBLE"),
        ("layout_d", "DOUBLE"),
    ],
    "file_imports": [
        ("snapshot_idx", "INTEGER"),
        ("source_file", "VARCHAR"),
        ("target_file", "VARCHAR"),
    ],
    "cochange_pairs": [
        ("snapshot_idx", "INTEGER"),
        ("file_a", "VARCHAR"),
        ("file_b", "VARCHAR"),
        ("shared_commits", "INTEGER"),
        ("coupling_ratio", "DOUBLE"),
    ],
    "external_deps": [
        ("snapshot_idx", "INTEGER"),
        ("ecosystem", "VARCHAR"),
        ("package_name", "VARCHAR"),
        ("version", "VARCHAR"),
        ("is_direct", "BOOLEAN"),
    ],
    "lint_diagnostics": [
        ("snapshot_idx", "INTEGER"),
        ("file_path", "VARCHAR"),
        ("linter", "VARCHAR"),
        ("line", "INTEGER"),
        ("col", "INTEGER"),
        ("rule_code", "VARCHAR"),
        ("category", "VARCHAR"),
        ("message", "VARCHAR"),
        ("fixable", "BOOLEAN"),
        ("metadata", "VARIANT"),
    ],
    "annotations": [
        ("annotation_id", "VARCHAR"),
        ("file_path", "VARCHAR"),
        ("author", "VARCHAR"),
        ("tag", "VARCHAR"),
        ("body", "VARCHAR"),
        ("created_at", "TIMESTAMP"),
    ],
    "sandbox_actions": [
        ("action_id", "VARCHAR"),
        ("action_seq", "INTEGER"),
        ("session_id", "VARCHAR"),
        ("author", "VARCHAR"),
        ("tool", "VARCHAR"),
        ("target_path", "VARCHAR"),
        ("secondary_path", "VARCHAR"),
        ("district_path", "VARCHAR"),
        ("summary", "VARCHAR"),
        ("velocity_cost", "INTEGER"),
        ("active", "BOOLEAN"),
        ("created_at", "TIMESTAMP"),
    ],
}

EXPORT_TABLES = tuple(t for t in _TABLE_SCHEMAS if t != "sandbox_actions")
ANALYSIS_TABLES = tuple(t for t in EXPORT_TABLES if t != "annotations")


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
    return f'"{ident.replace('"', '""')}"'


def quote_catalog_prefix(prefix: str) -> str:
    """Quote a single or dotted catalog prefix (e.g. `lake` or `remote.lake`)."""
    return ".".join(quote_ident(part) for part in prefix.split(".") if part)


def escape_sql_literal(value: str) -> str:
    """Escape single quotes for SQL string literals where parameter binding is unsupported."""
    return value.replace("'", "''")


def load_duckdb_extensions(
    con: duckdb.DuckDBPyConnection,
    extensions: tuple[str, ...] = ("ducklake", "quack"),
) -> None:
    """Load required DuckDB extensions, installing them on demand if missing."""
    for ext in extensions:
        try:
            con.execute(f"LOAD {ext};")
        except duckdb.Error:
            con.execute(f"INSTALL {ext}; LOAD {ext};")


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
        parts = [p for p in re.split(r"[/:]", cleaned) if p]
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
        load_duckdb_extensions(con)
        attach_opts = [
            f"DATA_PATH '{escape_sql_literal(str(self.parquet_dir))}'",
            "AUTOMATIC_MIGRATION true",
            f"DATA_INLINING_ROW_LIMIT {DATA_INLINING_LIMIT}",
        ]
        if read_only:
            attach_opts.append("READ_ONLY")
        cat_literal = escape_sql_literal(str(self.catalog_path))
        cat_q = quote_ident(self.catalog_name)
        con.execute(f"ATTACH 'ducklake:{cat_literal}' AS {cat_q} ({', '.join(attach_opts)});")
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
        """Create nested DuckLake 1.1 schemas `repos.<owner>.<repo>` and all tables."""
        o = sanitize_identifier(owner)
        r = sanitize_identifier(repo)
        cat = quote_catalog_prefix(catalog_prefix or self.catalog_name)
        schema_dot = self.schema_dot_path(o, r)

        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos;")
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos.{quote_ident(o)};")
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {cat}.repos.{quote_ident(o)}.{quote_ident(r)};")

        pfx = self.schema_prefix(o, r, catalog_prefix=catalog_prefix)
        for tbl, cols in _TABLE_SCHEMAS.items():
            cols_sql = ", ".join(f"{name} {dtype}" for name, dtype in cols)
            con.execute(f"CREATE TABLE IF NOT EXISTS {pfx}.{tbl} ({cols_sql});")

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
        tables = ANALYSIS_TABLES if preserve_annotations else EXPORT_TABLES
        for tbl in tables:
            con.execute(f"DELETE FROM {pfx}.{tbl};")

    def _insert_rows(
        self,
        con: duckdb.DuckDBPyConnection,
        pfx: str,
        table_name: str,
        rows: list[tuple[Any, ...]],
    ) -> None:
        if not rows:
            return
        cols = _TABLE_SCHEMAS[table_name]
        # Stage through a connection-local temp table because Quack remote writes
        # do not accept bound parameters directly against `remote.*` tables.
        tmp = f"_tmp_{table_name}"
        tmp_ddl = ", ".join(
            f"{col} {'VARCHAR' if dtype == 'VARIANT' else dtype}" for col, dtype in cols
        )
        select_expr = ", ".join(
            f"{col}::JSON::VARIANT" if dtype == "VARIANT" else col for col, dtype in cols
        )
        placeholders = ", ".join("?" for _ in cols)
        con.execute(f"CREATE OR REPLACE TEMP TABLE {tmp} ({tmp_ddl});")
        con.executemany(f"INSERT INTO {tmp} VALUES ({placeholders});", rows)
        con.execute(f"INSERT INTO {pfx}.{table_name} SELECT {select_expr} FROM {tmp};")

    def _insert_models(
        self,
        con: duckdb.DuckDBPyConnection,
        pfx: str,
        table_name: str,
        models: Sequence[BaseModel],
    ) -> None:
        if not models:
            return
        cols = _TABLE_SCHEMAS[table_name]

        def _cell(val: Any, dtype: str) -> Any:
            if dtype == "VARIANT":
                if isinstance(val, list):
                    val = [x.model_dump() if isinstance(x, BaseModel) else x for x in val]
                return json.dumps(val)
            if isinstance(val, Enum):
                return val.value
            if isinstance(val, datetime):
                return val.replace(tzinfo=None)
            return val

        rows = [tuple(_cell(getattr(m, col), dtype) for col, dtype in cols) for m in models]
        self._insert_rows(con, pfx, table_name, rows)

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
        """Atomically write one keyframe's records into DuckLake (local or remote Quack)."""
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        con.execute("BEGIN TRANSACTION;")
        try:
            self._insert_models(con, pfx, "snapshots", [snapshot])
            self._insert_models(con, pfx, "districts", districts)
            self._insert_models(con, pfx, "file_metrics", files)
            self._insert_models(con, pfx, "file_imports", imports)
            self._insert_models(con, pfx, "cochange_pairs", cochanges)
            self._insert_models(con, pfx, "external_deps", deps)
            self._insert_models(con, pfx, "lint_diagnostics", diagnostics)
            con.execute("COMMIT;")
        except Exception:
            con.execute("ROLLBACK;")
            raise

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
        self._insert_models(con, pfx, "annotations", [annotation])

    def get_annotation_changes(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        start_snapshot: int = 0,
    ) -> list[dict[str, Any]]:
        """Query DuckLake `ducklake_table_changes()` for the live Mayor Notes changelog."""
        schema_dot = self.schema_dot_path(owner, repo)
        cat = escape_sql_literal(self.catalog_name)
        cur = con.execute(f"SELECT * FROM ducklake_current_snapshot('{cat}')").fetchone()
        if not cur or cur[0] is None:
            return []
        end_snap = int(cur[0])
        if start_snapshot > end_snap:
            return []
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
        rows = con.execute(
            f"""
            SELECT {", ".join(cols)}
            FROM ducklake_table_changes(
                '{cat}', '{schema_dot}', 'annotations', {int(start_snapshot)}, {end_snap}
            )
            ORDER BY snapshot_id DESC, created_at DESC;
            """
        ).fetchall()
        results = []
        for row in rows:
            item = dict(zip(cols, row, strict=True))
            if isinstance(item.get("created_at"), datetime):
                item["created_at"] = item["created_at"].isoformat()
            results.append(item)
        return results

    def add_sandbox_action(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        action: SandboxAction,
        *,
        catalog_prefix: str | None = None,
    ) -> SandboxAction:
        """Insert a collaborative Mayor sandbox action into DuckLake via Data Inlining."""
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        con.execute(f"DELETE FROM {pfx}.sandbox_actions WHERE active = false;")
        rows = con.execute(
            f"SELECT COALESCE(MAX(action_seq), 0) FROM {pfx}.sandbox_actions;"
        ).fetchall()
        next_seq = int(rows[0][0]) + 1 if rows else 1
        persisted = action.model_copy(update={"action_seq": next_seq})
        self._insert_models(con, pfx, "sandbox_actions", [persisted])
        return persisted

    def query_sandbox_actions(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        *,
        catalog_prefix: str | None = None,
    ) -> list[SandboxAction]:
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        cols = [c for c, _ in _TABLE_SCHEMAS["sandbox_actions"]]
        rows = con.execute(
            f"SELECT {', '.join(cols)} FROM {pfx}.sandbox_actions ORDER BY action_seq ASC;"
        ).fetchall()
        return [SandboxAction.model_validate(dict(zip(cols, r, strict=True))) for r in rows]

    def toggle_sandbox_action(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        action_id: str,
        active: bool,
        *,
        catalog_prefix: str | None = None,
    ) -> None:
        if not _ACTION_ID_RE.fullmatch(action_id):
            raise ValueError(f"Invalid sandbox action_id: {action_id}")
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        active_sql = "true" if active else "false"
        con.execute(
            f"UPDATE {pfx}.sandbox_actions SET active = {active_sql} "
            f"WHERE action_id = '{action_id}';"
        )

    def clear_sandbox_actions(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        *,
        catalog_prefix: str | None = None,
    ) -> None:
        pfx = self.schema_prefix(owner, repo, catalog_prefix=catalog_prefix)
        con.execute(f"DELETE FROM {pfx}.sandbox_actions;")

    def _build_repo_ref(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        schema_path: str,
        source: str,
    ) -> RepoRef:
        pfx = self.schema_prefix(owner, repo)
        row = con.execute(
            f"""
            SELECT
                COUNT(*)::INTEGER,
                COALESCE(MAX(snapshot_idx), 0)::INTEGER,
                arg_max(health_grade, snapshot_idx),
                arg_max(city_archetype_title, snapshot_idx),
                COALESCE(arg_max(total_files, snapshot_idx), 0)::INTEGER
            FROM {pfx}.snapshots;
            """
        ).fetchone()
        total_snaps = int(row[0]) if row else 0
        latest_idx = int(row[1]) if row else 0
        return RepoRef(
            owner=owner,
            repo=repo,
            schema_path=schema_path,
            repo_url_or_path=source,
            latest_snapshot_idx=latest_idx,
            latest_grade=str(row[2]) if row and row[2] is not None else "A",
            latest_title=(str(row[3]) if row and row[3] is not None else "Sunlit Civic Metropolis"),
            total_snapshots=total_snaps,
            total_files=int(row[4]) if row else 0,
        )

    def get_repo(self, con: duckdb.DuckDBPyConnection, owner: str, repo: str) -> RepoRef | None:
        """Fetch one analyzed repository summary from `repo_registry`."""
        o = sanitize_identifier(owner)
        r = sanitize_identifier(repo)
        cat = quote_ident(self.catalog_name)
        row = con.execute(
            f"SELECT owner, repo, schema_path, source FROM {cat}.repos.repo_registry "
            "WHERE owner = ? AND repo = ? LIMIT 1;",
            [o, r],
        ).fetchone()
        if not row:
            return None
        return self._build_repo_ref(con, str(row[0]), str(row[1]), str(row[2]), str(row[3]))

    def list_repos(self, con: duckdb.DuckDBPyConnection) -> list[RepoRef]:
        """List all analyzed repositories and their latest snapshot summary."""
        cat = quote_ident(self.catalog_name)
        rows = con.execute(
            f"SELECT owner, repo, schema_path, source "
            f"FROM {cat}.repos.repo_registry ORDER BY updated_at DESC;"
        ).fetchall()
        return [self._build_repo_ref(con, r[0], r[1], r[2], r[3]) for r in rows]

    def export_table_parquet(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        table_name: str,
        dest: Path,
    ) -> Path:
        """Export one repo table to a DuckDB-Wasm-compatible Parquet file."""
        if table_name not in EXPORT_TABLES:
            raise ValueError(f"Unknown export table: {table_name}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        pfx = self.schema_prefix(owner, repo)
        cols = _TABLE_SCHEMAS[table_name]
        cols_expr = ", ".join(
            f"to_json({col})::VARCHAR AS {col}" if dtype == "VARIANT" else col
            for col, dtype in cols
        )
        dest_esc = escape_sql_literal(str(dest))
        con.execute(
            f"COPY (SELECT {cols_expr} FROM {pfx}.{table_name}) TO '{dest_esc}' (FORMAT PARQUET);"
        )
        return dest

    def export_repo_parquet(
        self,
        con: duckdb.DuckDBPyConnection,
        owner: str,
        repo: str,
        out_dir: Path,
    ) -> dict[str, Path]:
        """Export every table for a repo to DuckDB-Wasm-compatible Parquet files."""
        out_dir.mkdir(parents=True, exist_ok=True)
        return {
            tbl: self.export_table_parquet(con, owner, repo, tbl, out_dir / f"{tbl}.parquet")
            for tbl in EXPORT_TABLES
        }

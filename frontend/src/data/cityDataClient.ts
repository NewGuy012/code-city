import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbEhWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";

import type {
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
} from "../types/city";

function parseJsonField<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof val === "object") return val as T;
  return fallback;
}

export interface CitySnapshotBundle {
  snapshot: Snapshot;
  districts: District[];
  files: FileMetric[];
  imports: FileImport[];
  cochanges: CochangePair[];
  deps: ExternalDep[];
}

export class CityDataClient {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private loadedKey: string | null = null;

  async initWasm(): Promise<duckdb.AsyncDuckDBConnection> {
    if (this.conn) return this.conn;
    const bundle = await duckdb.selectBundle({
      mvp: {
        mainModule: duckdbMvpWasm,
        mainWorker: duckdbMvpWorker,
      },
      eh: {
        mainModule: duckdbEhWasm,
        mainWorker: duckdbEhWorker,
      },
    });
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    this.db = db;
    this.conn = await db.connect();
    return this.conn;
  }

  async loadParquetTables(baseUrl: string, cacheKey: string): Promise<void> {
    if (this.loadedKey === cacheKey && this.conn) return;
    const conn = await this.initWasm();
    const db = this.db!;
    const tables = [
      "snapshots",
      "districts",
      "file_metrics",
      "file_imports",
      "cochange_pairs",
      "external_deps",
      "lint_diagnostics",
      "annotations",
    ];
    for (const table of tables) {
      const url = `${baseUrl.replace(/\/$/, "")}/${table}.parquet`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Failed to fetch ${url}: ${resp.status}`);
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const vpath = `${table}.parquet`;
      await db.registerFileBuffer(vpath, buf);
      await conn.query(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_parquet('${vpath}');`,
      );
    }
    this.loadedKey = cacheKey;
  }

  async querySnapshots(): Promise<Snapshot[]> {
    const conn = await this.initWasm();
    const res = await conn.query(`SELECT * FROM snapshots ORDER BY snapshot_idx ASC;`);
    return res.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        commit_sha: String(r.commit_sha ?? ""),
        committed_at: String(r.committed_at ?? ""),
        git_tag: r.git_tag ? String(r.git_tag) : null,
        total_files: Number(r.total_files ?? 0),
        total_sloc: Number(r.total_sloc ?? 0),
        total_lint_issues: Number(r.total_lint_issues ?? 0),
        language_breakdown: parseJsonField<Record<string, number>>(r.language_breakdown, {}),
        health_score: Number(r.health_score ?? 100),
        health_grade: String(r.health_grade ?? "A"),
        city_archetype_title: String(r.city_archetype_title ?? "Sunlit Civic Metropolis"),
        advisor_alerts: parseJsonField(r.advisor_alerts, []),
      };
    });
  }

  async querySnapshotBundle(snapshotIdx: number): Promise<CitySnapshotBundle> {
    const conn = await this.initWasm();
    const snaps = await this.querySnapshots();
    const snapshot = snaps.find((s) => s.snapshot_idx === snapshotIdx) ?? snaps[0];
    if (!snapshot) {
      throw new Error(`No snapshot found for index ${snapshotIdx}`);
    }

    const distRes = await conn.query(
      `SELECT * FROM districts WHERE snapshot_idx = ${snapshotIdx} ORDER BY district_path;`,
    );
    const districts: District[] = distRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        district_path: String(r.district_path),
        display_name: String(r.display_name),
        zone_type: String(r.zone_type) as ZoneType,
        bounds_x: Number(r.bounds_x),
        bounds_z: Number(r.bounds_z),
        bounds_w: Number(r.bounds_w),
        bounds_d: Number(r.bounds_d),
        file_count: Number(r.file_count ?? 0),
        avg_health: Number(r.avg_health ?? 100),
        summary_blurb: String(r.summary_blurb ?? ""),
      };
    });

    const filesRes = await conn.query(
      `SELECT * FROM file_metrics WHERE snapshot_idx = ${snapshotIdx} ORDER BY file_path;`,
    );
    const files: FileMetric[] = filesRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        file_path: String(r.file_path),
        district_path: String(r.district_path),
        language: String(r.language),
        zone_type: String(r.zone_type) as ZoneType,
        building_archetype: String(r.building_archetype) as BuildingArchetype,
        role_confidence: Number(r.role_confidence ?? 0.75),
        role_signals: parseJsonField(r.role_signals, {}),
        sloc: Number(r.sloc ?? 0),
        symbol_count: Number(r.symbol_count ?? 0),
        max_complexity: Number(r.max_complexity ?? 1),
        type_or_doc_ratio: Number(r.type_or_doc_ratio ?? 0),
        lint_issue_count: Number(r.lint_issue_count ?? 0),
        format_drift: Boolean(r.format_drift),
        lint_by_category: parseJsonField(r.lint_by_category, {}),
        churn_90d: Number(r.churn_90d ?? 0),
        bugfix_commits_90d: Number(r.bugfix_commits_90d ?? 0),
        distinct_authors_90d: Number(r.distinct_authors_90d ?? 0),
        hotspot_score: Number(r.hotspot_score ?? 0),
        condition_flags: parseJsonField(r.condition_flags, {}),
        layout_x: Number(r.layout_x),
        layout_z: Number(r.layout_z),
        layout_w: Number(r.layout_w),
        layout_d: Number(r.layout_d),
      };
    });

    const impRes = await conn.query(
      `SELECT * FROM file_imports WHERE snapshot_idx = ${snapshotIdx};`,
    );
    const imports: FileImport[] = impRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        source_file: String(r.source_file),
        target_file: String(r.target_file),
      };
    });

    const coRes = await conn.query(
      `SELECT * FROM cochange_pairs WHERE snapshot_idx = ${snapshotIdx} ORDER BY coupling_ratio DESC;`,
    );
    const cochanges: CochangePair[] = coRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        file_a: String(r.file_a),
        file_b: String(r.file_b),
        shared_commits: Number(r.shared_commits),
        coupling_ratio: Number(r.coupling_ratio),
      };
    });

    const depRes = await conn.query(
      `SELECT * FROM external_deps WHERE snapshot_idx = ${snapshotIdx} ORDER BY is_direct DESC, package_name ASC;`,
    );
    const deps: ExternalDep[] = depRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        ecosystem: String(r.ecosystem),
        package_name: String(r.package_name),
        version: String(r.version ?? ""),
        is_direct: Boolean(r.is_direct),
        parent_package: r.parent_package ? String(r.parent_package) : null,
      };
    });

    return { snapshot, districts, files, imports, cochanges, deps };
  }

  async queryBlastRadius(snapshotIdx: number, sourceFile: string): Promise<BlastRadiusResult> {
    const conn = await this.initWasm();
    const esc = sourceFile.replace(/'/g, "''");
    const blastRes = await conn.query(`
      WITH RECURSIVE impacted(file_path, hop_distance, path) AS (
        SELECT source_file, 1, [target_file, source_file]
        FROM file_imports
        WHERE snapshot_idx = ${snapshotIdx} AND target_file = '${esc}'
        UNION ALL
        SELECT fi.source_file, i.hop_distance + 1, list_append(i.path, fi.source_file)
        FROM file_imports fi
        JOIN impacted i ON fi.target_file = i.file_path
        WHERE fi.snapshot_idx = ${snapshotIdx}
          AND i.hop_distance < 5
          AND NOT list_contains(i.path, fi.source_file)
      ),
      dedup AS (
        SELECT file_path, MIN(hop_distance) AS hop_distance
        FROM impacted
        WHERE file_path != '${esc}'
        GROUP BY file_path
      )
      SELECT d.file_path, d.hop_distance, fm.district_path, fm.building_archetype
      FROM dedup d
      JOIN file_metrics fm
        ON fm.snapshot_idx = ${snapshotIdx} AND fm.file_path = d.file_path
      ORDER BY d.hop_distance ASC, fm.hotspot_score DESC;
    `);
    const impacted_files: BlastRadiusNode[] = blastRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        file_path: String(r.file_path),
        hop_distance: Number(r.hop_distance),
        district_path: String(r.district_path),
        building_archetype: String(r.building_archetype) as BuildingArchetype,
      };
    });

    const coRes = await conn.query(`
      SELECT snapshot_idx, file_a, file_b, shared_commits, coupling_ratio
      FROM cochange_pairs
      WHERE snapshot_idx = ${snapshotIdx}
        AND (file_a = '${esc}' OR file_b = '${esc}')
      ORDER BY coupling_ratio DESC, shared_commits DESC
      LIMIT 15;
    `);
    const fault_lines: CochangePair[] = coRes.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        file_a: String(r.file_a),
        file_b: String(r.file_b),
        shared_commits: Number(r.shared_commits),
        coupling_ratio: Number(r.coupling_ratio),
      };
    });

    return { source_file: sourceFile, snapshot_idx: snapshotIdx, impacted_files, fault_lines };
  }

  async queryFileHistory(
    filePath: string,
  ): Promise<
    Array<{ snapshot_idx: number; sloc: number; hotspot_score: number; lint_issue_count: number }>
  > {
    const conn = await this.initWasm();
    const esc = filePath.replace(/'/g, "''");
    const res = await conn.query(`
      SELECT snapshot_idx, sloc, hotspot_score, lint_issue_count
      FROM file_metrics
      WHERE file_path = '${esc}'
      ORDER BY snapshot_idx ASC;
    `);
    return res.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        sloc: Number(r.sloc),
        hotspot_score: Number(r.hotspot_score),
        lint_issue_count: Number(r.lint_issue_count),
      };
    });
  }

  async queryFileDiagnostics(snapshotIdx: number, filePath: string): Promise<LintDiagnostic[]> {
    const conn = await this.initWasm();
    const esc = filePath.replace(/'/g, "''");
    const res = await conn.query(`
      SELECT *
      FROM lint_diagnostics
      WHERE snapshot_idx = ${snapshotIdx} AND file_path = '${esc}'
      ORDER BY line ASC, col ASC
      LIMIT 100;
    `);
    return res.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        snapshot_idx: Number(r.snapshot_idx),
        file_path: String(r.file_path),
        linter: String(r.linter),
        line: Number(r.line),
        col: Number(r.col),
        rule_code: String(r.rule_code),
        category: String(r.category),
        message: String(r.message),
        fixable: Boolean(r.fixable),
        metadata: parseJsonField(r.metadata, {}),
      };
    });
  }

  async queryAnnotations(): Promise<Annotation[]> {
    const conn = await this.initWasm();
    const res = await conn.query(`SELECT * FROM annotations ORDER BY created_at DESC;`);
    return res.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        annotation_id: String(r.annotation_id),
        file_path: String(r.file_path),
        author: String(r.author),
        tag: String(r.tag),
        body: String(r.body),
        created_at: String(r.created_at),
      };
    });
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
    this.loadedKey = null;
  }
}

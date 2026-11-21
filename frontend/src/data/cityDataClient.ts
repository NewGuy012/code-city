import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbEhWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

import type { SandboxActionRecord } from "../game/sandboxOverlay";
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
  RepoRef,
  Snapshot,
  StaticManifest,
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

export interface TourLandmark {
  step: number;
  title: string;
  subtitle: string;
  narration: string;
  file_path: string;
  district_path: string;
  zone_type: ZoneType;
  building_archetype: BuildingArchetype;
  sloc: number;
  max_complexity: number;
  churn_90d: number;
  hotspot_score: number;
  lint_issue_count: number;
  layout_x: number;
  layout_z: number;
  layout_w: number;
  layout_d: number;
}

export interface FixDiffResult {
  file_path: string;
  linter: string;
  has_changes: boolean;
  diff: string;
  fixed_content?: string | null;
  message: string;
}

export interface HealthReportData {
  owner: string;
  repo: string;
  snapshot_idx: number;
  commit_sha: string;
  git_tag: string | null;
  health_score: number;
  health_grade: string;
  city_archetype_title: string;
  total_files: number;
  total_sloc: number;
  total_lint_issues: number;
  greenbelt_pct: number;
  lone_keeper_files: number;
  language_breakdown: Record<string, number>;
  advisor_alerts: Snapshot["advisor_alerts"];
  top_hotspots: Array<{
    file_path: string;
    district_path: string;
    building_archetype: BuildingArchetype;
    hotspot_score: number;
    churn_90d: number;
    lint_issue_count: number;
    max_complexity: number;
    distinct_authors_90d: number;
  }>;
}

export interface QuackSnippetInfo {
  quack_uri: string | null;
  token: string | null;
  proxy_url: string;
  snippet: string;
}

export interface AnnotationChangeEvent {
  snapshot_id: number;
  rowid: number;
  change_type: string;
  annotation_id: string;
  file_path: string;
  author: string;
  tag: string;
  body: string;
  created_at: string;
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

  async loadParquetTables(baseUrl: string, cacheKey: string, force = false): Promise<void> {
    if (!force && this.loadedKey === cacheKey && this.conn) return;
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
    await this.ensureSandboxTable();
    this.loadedKey = cacheKey;
  }

  async ensureSandboxTable(): Promise<void> {
    const conn = await this.initWasm();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sandbox_actions (
        action_id VARCHAR,
        action_seq INTEGER,
        tool VARCHAR,
        target_path VARCHAR,
        secondary_path VARCHAR,
        district_path VARCHAR,
        summary VARCHAR,
        velocity_cost INTEGER,
        active BOOLEAN,
        created_at VARCHAR
      );
    `);
  }

  async querySandboxActions(): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const conn = await this.initWasm();
    const res = await conn.query(`SELECT * FROM sandbox_actions ORDER BY action_seq ASC;`);
    return res.toArray().map((row) => {
      const r = row.toJSON() as Record<string, unknown>;
      return {
        action_id: String(r.action_id),
        action_seq: Number(r.action_seq),
        tool: String(r.tool) as SandboxActionRecord["tool"],
        target_path: String(r.target_path),
        secondary_path: r.secondary_path ? String(r.secondary_path) : null,
        district_path: String(r.district_path),
        summary: String(r.summary),
        velocity_cost: Number(r.velocity_cost ?? 0),
        active: Boolean(r.active),
        created_at: String(r.created_at),
      };
    });
  }

  async appendSandboxAction(
    action: Omit<SandboxActionRecord, "action_id" | "action_seq" | "active" | "created_at">,
  ): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const conn = await this.initWasm();
    // Clear inactive redo tail when branching from an undone state
    await conn.query(`DELETE FROM sandbox_actions WHERE active = false;`);
    const maxRes = await conn.query(`SELECT COALESCE(MAX(action_seq), 0) AS m FROM sandbox_actions;`);
    const maxRow = maxRes.toArray()[0]?.toJSON() as Record<string, unknown> | undefined;
    const nextSeq = Number(maxRow?.m ?? 0) + 1;
    const esc = (v: string) => v.replace(/'/g, "''");
    const id = `sbx-${Date.now().toString(36)}-${nextSeq}`;
    const secSql = action.secondary_path ? `'${esc(action.secondary_path)}'` : "NULL";
    const nowIso = new Date().toISOString();
    await conn.query(`
      INSERT INTO sandbox_actions VALUES (
        '${esc(id)}',
        ${nextSeq},
        '${esc(action.tool)}',
        '${esc(action.target_path)}',
        ${secSql},
        '${esc(action.district_path)}',
        '${esc(action.summary)}',
        ${Math.round(action.velocity_cost)},
        true,
        '${esc(nowIso)}'
      );
    `);
    return this.querySandboxActions();
  }

  async undoSandboxAction(): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const conn = await this.initWasm();
    await conn.query(`
      UPDATE sandbox_actions
      SET active = false
      WHERE action_seq = (SELECT MAX(action_seq) FROM sandbox_actions WHERE active = true);
    `);
    return this.querySandboxActions();
  }

  async redoSandboxAction(): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const conn = await this.initWasm();
    await conn.query(`
      UPDATE sandbox_actions
      SET active = true
      WHERE action_seq = (SELECT MIN(action_seq) FROM sandbox_actions WHERE active = false);
    `);
    return this.querySandboxActions();
  }

  async resetSandboxActions(): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const conn = await this.initWasm();
    await conn.query(`DELETE FROM sandbox_actions;`);
    return [];
  }

  async runReadSql(sql: string): Promise<Array<Record<string, unknown>>> {
    const conn = await this.initWasm();
    const res = await conn.query(sql);
    return res.toArray().map((row) => row.toJSON() as Record<string, unknown>);
  }

  async detectStaticManifest(): Promise<StaticManifest | null> {
    try {
      const resp = await fetch("./data/manifest.json", { cache: "no-store" });
      if (!resp.ok) return null;
      const data = (await resp.json()) as StaticManifest;
      return data && data.mode === "static" ? data : null;
    } catch {
      return null;
    }
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
          AND i.hop_distance < 6
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

  async queryTourLandmarks(snapshotIdx: number): Promise<TourLandmark[]> {
    const bundle = await this.querySnapshotBundle(snapshotIdx);
    const files = [...bundle.files].sort((a, b) => b.sloc - a.sloc);
    if (files.length === 0) return [];
    const used = new Set<string>();
    const stops: TourLandmark[] = [];

    const pick = (
      title: string,
      subtitle: string,
      candidates: FileMetric[],
      narrate: (f: FileMetric) => string,
    ) => {
      const pool = candidates.filter((f) => !used.has(f.file_path));
      const fallback = files.filter((f) => !used.has(f.file_path));
      const chosen = pool[0] ?? fallback[0];
      if (!chosen) return;
      used.add(chosen.file_path);
      stops.push({
        step: stops.length + 1,
        title,
        subtitle,
        narration: narrate(chosen),
        file_path: chosen.file_path,
        district_path: chosen.district_path,
        zone_type: chosen.zone_type,
        building_archetype: chosen.building_archetype,
        sloc: chosen.sloc,
        max_complexity: chosen.max_complexity,
        churn_90d: chosen.churn_90d,
        hotspot_score: chosen.hotspot_score,
        lint_issue_count: chosen.lint_issue_count,
        layout_x: chosen.layout_x,
        layout_z: chosen.layout_z,
        layout_w: chosen.layout_w,
        layout_d: chosen.layout_d,
      });
    };

    pick(
      "Harbor & City Gate",
      "Where requests and CLI traffic enter the city",
      files.filter((f) => f.building_archetype === "grand_terminal"),
      (f) =>
        `Start at ${f.file_path} in ${f.district_path}/ — entrypoint handling external traffic (${f.sloc} SLOC).`,
    );
    pick(
      "Downtown City Hall",
      "Core architectural hub & central orchestrator",
      files.filter(
        (f) => f.building_archetype === "city_hall" || f.building_archetype === "office_tower",
      ),
      (f) =>
        `${f.file_path} anchors core domain logic (${f.sloc} SLOC, max complexity ${f.max_complexity}).`,
    );
    pick(
      "Vaults & Reservoir",
      "Schemas, models, and persistent state",
      files.filter(
        (f) => f.building_archetype === "twin_silos" || f.building_archetype === "archive_vault",
      ),
      (f) => `${f.file_path} safeguards data contracts and storage (${f.sloc} SLOC).`,
    );
    pick(
      "Active Construction Zone",
      "Highest 90-day churn & refactor hotspot",
      [...files].sort((a, b) => b.hotspot_score - a.hotspot_score),
      (f) =>
        `Hardhats on at ${f.file_path} — ${f.churn_90d} churn weight and hotspot score ${f.hotspot_score.toFixed(1)}.`,
    );
    pick(
      "Greenbelt Proving Parks",
      "Automated test suites protecting the skyline",
      files.filter((f) => f.building_archetype === "park_stadium"),
      (f) => `${f.file_path} anchors automated verification (${f.sloc} SLOC).`,
    );
    return stops;
  }

  async queryHealthReport(
    owner: string,
    repo: string,
    snapshotIdx: number,
  ): Promise<HealthReportData> {
    const bundle = await this.querySnapshotBundle(snapshotIdx);
    const snap = bundle.snapshot;
    const testSloc = bundle.files
      .filter((f) => f.building_archetype === "park_stadium")
      .reduce((acc, f) => acc + f.sloc, 0);
    const loneKeepers = bundle.files.filter(
      (f) => f.distinct_authors_90d === 1 && f.sloc >= 40,
    ).length;
    const topHotspots = [...bundle.files]
      .sort((a, b) => b.hotspot_score - a.hotspot_score)
      .slice(0, 8)
      .map((f) => ({
        file_path: f.file_path,
        district_path: f.district_path,
        building_archetype: f.building_archetype,
        hotspot_score: f.hotspot_score,
        churn_90d: f.churn_90d,
        lint_issue_count: f.lint_issue_count,
        max_complexity: f.max_complexity,
        distinct_authors_90d: f.distinct_authors_90d,
      }));
    return {
      owner,
      repo,
      snapshot_idx: snap.snapshot_idx,
      commit_sha: snap.commit_sha,
      git_tag: snap.git_tag,
      health_score: snap.health_score,
      health_grade: snap.health_grade,
      city_archetype_title: snap.city_archetype_title,
      total_files: snap.total_files,
      total_sloc: snap.total_sloc,
      total_lint_issues: snap.total_lint_issues,
      greenbelt_pct: Math.round((1000 * testSloc) / Math.max(1, snap.total_sloc)) / 10,
      lone_keeper_files: loneKeepers,
      language_breakdown: snap.language_breakdown,
      advisor_alerts: snap.advisor_alerts,
      top_hotspots: topHotspots,
    };
  }

  async queryFileHistory(filePath: string): Promise<
    Array<{
      snapshot_idx: number;
      sloc: number;
      hotspot_score: number;
      lint_issue_count: number;
    }>
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

  // Live Control Plane API calls (unavailable in zero-backend Static Report mode)
  async fetchRepos(): Promise<RepoRef[]> {
    const resp = await fetch("/api/repos");
    if (!resp.ok) throw new Error(`Failed to fetch repos: ${resp.status}`);
    return (await resp.json()) as RepoRef[];
  }

  async startAnalyze(
    source: string,
    maxKeyframes = 16,
  ): Promise<{ job_id: string; owner: string; repo: string }> {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, max_keyframes: maxKeyframes }),
    });
    if (!resp.ok) throw new Error(`Analyze request failed: ${resp.status}`);
    return (await resp.json()) as { job_id: string; owner: string; repo: string };
  }

  async fetchFixDiff(owner: string, repo: string, filePath: string): Promise<FixDiffResult> {
    const resp = await fetch(`/api/repos/${owner}/${repo}/fix-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: filePath }),
    });
    if (!resp.ok) throw new Error(`Fix diff failed: ${resp.status}`);
    return (await resp.json()) as FixDiffResult;
  }

  async postAnnotation(
    owner: string,
    repo: string,
    payload: { file_path: string; author: string; tag: string; body: string },
  ): Promise<Annotation> {
    const resp = await fetch(`/api/repos/${owner}/${repo}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`Failed to save annotation: ${resp.status}`);
    return (await resp.json()) as Annotation;
  }

  async fetchAnnotationChanges(owner: string, repo: string): Promise<AnnotationChangeEvent[]> {
    const resp = await fetch(`/api/repos/${owner}/${repo}/annotations/changes`);
    if (!resp.ok) return [];
    return (await resp.json()) as AnnotationChangeEvent[];
  }

  async fetchQuackSnippet(owner: string, repo: string): Promise<QuackSnippetInfo> {
    const resp = await fetch(`/api/repos/${owner}/${repo}/quack-snippet`);
    if (!resp.ok) throw new Error(`Failed to fetch quack snippet: ${resp.status}`);
    return (await resp.json()) as QuackSnippetInfo;
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

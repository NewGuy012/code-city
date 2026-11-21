import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbEhWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbMvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbEhWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbMvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

import type { AuthorSummary } from "../components/DisastersMenu";
import type { SandboxActionRecord } from "../game/sandboxOverlay";
import type {
  Annotation,
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
  message: string;
}

export interface HealthReportData {
  owner: string;
  repo: string;
  snapshot_idx: number;
  health_score: number;
  health_grade: string;
  city_archetype_title: string;
  total_lint_issues: number;
  greenbelt_pct: number;
  lone_keeper_files: number;
  language_breakdown: Record<string, number>;
  top_hotspots: Array<{
    file_path: string;
    hotspot_score: number;
    max_complexity: number;
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

const PARQUET_TABLES = [
  "snapshots",
  "districts",
  "file_metrics",
  "file_imports",
  "cochange_pairs",
  "external_deps",
  "lint_diagnostics",
  "annotations",
] as const;

export function buildTourLandmarks(bundle: CitySnapshotBundle): TourLandmark[] {
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
    const chosen =
      candidates.find((f) => !used.has(f.file_path)) ?? files.find((f) => !used.has(f.file_path));
    if (!chosen) return;
    used.add(chosen.file_path);
    stops.push({
      step: stops.length + 1,
      title,
      subtitle,
      narration: narrate(chosen),
      file_path: chosen.file_path,
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

export function buildHealthReport(
  owner: string,
  repo: string,
  bundle: CitySnapshotBundle,
): HealthReportData {
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
      hotspot_score: f.hotspot_score,
      max_complexity: f.max_complexity,
    }));
  return {
    owner,
    repo,
    snapshot_idx: snap.snapshot_idx,
    health_score: snap.health_score,
    health_grade: snap.health_grade,
    city_archetype_title: snap.city_archetype_title,
    total_lint_issues: snap.total_lint_issues,
    greenbelt_pct: Math.round((1000 * testSloc) / Math.max(1, snap.total_sloc)) / 10,
    lone_keeper_files: loneKeepers,
    language_breakdown: snap.language_breakdown,
    top_hotspots: topHotspots,
  };
}

function mapCochangeRow(r: Record<string, unknown>): CochangePair {
  return {
    snapshot_idx: Number(r.snapshot_idx),
    file_a: String(r.file_a),
    file_b: String(r.file_b),
    shared_commits: Number(r.shared_commits),
    coupling_ratio: Number(r.coupling_ratio),
  };
}

export class CityDataClient {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private initPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
  private loadedKey: string | null = null;
  private sandboxTableReady = false;

  initWasm(): Promise<duckdb.AsyncDuckDBConnection> {
    if (this.conn) return Promise.resolve(this.conn);
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const bundle = await duckdb.selectBundle({
          mvp: { mainModule: duckdbMvpWasm, mainWorker: duckdbMvpWorker },
          eh: { mainModule: duckdbEhWasm, mainWorker: duckdbEhWorker },
        });
        const worker = new Worker(bundle.mainWorker!);
        const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
        const db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        this.db = db;
        this.conn = await db.connect();
        return this.conn;
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async runReadSql(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const conn = await this.initWasm();
    if (params.length === 0) {
      const res = await conn.query(sql);
      return res.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    }
    const stmt = await conn.prepare(sql);
    try {
      const res = await stmt.query(...params);
      return res.toArray().map((row) => row.toJSON() as Record<string, unknown>);
    } finally {
      await stmt.close();
    }
  }

  async loadParquetTables(baseUrl: string, cacheKey: string, force = false): Promise<void> {
    if (!force && this.loadedKey === cacheKey && this.conn) return;
    const conn = await this.initWasm();
    const db = this.db!;
    const cleanBase = baseUrl.replace(/\/$/, "");

    const buffers = await Promise.all(
      PARQUET_TABLES.map(async (table) => {
        const url = `${cleanBase}/${table}.parquet`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
        return { table, buf: new Uint8Array(await resp.arrayBuffer()) };
      }),
    );

    const repoChanged = this.loadedKey !== null && this.loadedKey !== cacheKey;
    for (const { table, buf } of buffers) {
      const vpath = `${table}.parquet`;
      await db.registerFileBuffer(vpath, buf);
      await conn.query(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_parquet('${vpath}');`,
      );
    }
    await this.ensureSandboxTable();
    if (repoChanged) {
      await conn.query(`DELETE FROM sandbox_actions;`);
    }
    this.loadedKey = cacheKey;
  }

  async ensureSandboxTable(): Promise<void> {
    if (this.sandboxTableReady) return;
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
    this.sandboxTableReady = true;
  }

  async querySandboxActions(): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const rows = await this.runReadSql(`SELECT * FROM sandbox_actions ORDER BY action_seq ASC;`);
    return rows.map((r) => ({
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
    }));
  }

  async appendSandboxAction(
    action: Omit<SandboxActionRecord, "action_id" | "action_seq" | "active" | "created_at">,
  ): Promise<SandboxActionRecord[]> {
    await this.ensureSandboxTable();
    const conn = await this.initWasm();
    await conn.query(`DELETE FROM sandbox_actions WHERE active = false;`);
    const maxRows = await this.runReadSql(
      `SELECT COALESCE(MAX(action_seq), 0) AS m FROM sandbox_actions;`,
    );
    const nextSeq = Number(maxRows[0]?.m ?? 0) + 1;
    const id = `sbx-${Date.now().toString(36)}-${nextSeq}`;
    await this.runReadSql(`INSERT INTO sandbox_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, ?);`, [
      id,
      nextSeq,
      action.tool,
      action.target_path,
      action.secondary_path ?? null,
      action.district_path,
      action.summary,
      Math.round(action.velocity_cost),
      new Date().toISOString(),
    ]);
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
    const rows = await this.runReadSql(`SELECT * FROM snapshots ORDER BY snapshot_idx ASC;`);
    return rows.map((r) => ({
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
    }));
  }

  async querySnapshotBundle(
    snapshotIdx: number,
    cachedSnapshots?: Snapshot[],
  ): Promise<CitySnapshotBundle> {
    const snaps = cachedSnapshots ?? (await this.querySnapshots());
    const snapshot = snaps.find((s) => s.snapshot_idx === snapshotIdx) ?? snaps[0];
    if (!snapshot) {
      throw new Error(`No snapshot found for index ${snapshotIdx}`);
    }

    const [distRows, fileRows, impRows, coRows, depRows] = await Promise.all([
      this.runReadSql(`SELECT * FROM districts WHERE snapshot_idx = ? ORDER BY district_path;`, [
        snapshotIdx,
      ]),
      this.runReadSql(`SELECT * FROM file_metrics WHERE snapshot_idx = ? ORDER BY file_path;`, [
        snapshotIdx,
      ]),
      this.runReadSql(`SELECT * FROM file_imports WHERE snapshot_idx = ?;`, [snapshotIdx]),
      this.runReadSql(
        `SELECT * FROM cochange_pairs WHERE snapshot_idx = ? ORDER BY coupling_ratio DESC;`,
        [snapshotIdx],
      ),
      this.runReadSql(
        `SELECT * FROM external_deps WHERE snapshot_idx = ? ORDER BY is_direct DESC, package_name ASC;`,
        [snapshotIdx],
      ),
    ]);

    const districts: District[] = distRows.map((r) => ({
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
    }));

    const files: FileMetric[] = fileRows.map((r) => ({
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
    }));

    const imports: FileImport[] = impRows.map((r) => ({
      snapshot_idx: Number(r.snapshot_idx),
      source_file: String(r.source_file),
      target_file: String(r.target_file),
    }));

    const cochanges: CochangePair[] = coRows.map(mapCochangeRow);

    const deps: ExternalDep[] = depRows.map((r) => ({
      snapshot_idx: Number(r.snapshot_idx),
      ecosystem: String(r.ecosystem),
      package_name: String(r.package_name),
      version: String(r.version ?? ""),
      is_direct: Boolean(r.is_direct),
    }));

    return { snapshot, districts, files, imports, cochanges, deps };
  }

  async queryBlastRadius(snapshotIdx: number, sourceFile: string): Promise<BlastRadiusResult> {
    const [blastRows, coRows] = await Promise.all([
      this.runReadSql(
        `
        WITH RECURSIVE impacted(file_path, hop_distance, path) AS (
          SELECT source_file, 1, [target_file, source_file]
          FROM file_imports
          WHERE snapshot_idx = ? AND target_file = ?
          UNION ALL
          SELECT fi.source_file, i.hop_distance + 1, list_append(i.path, fi.source_file)
          FROM file_imports fi
          JOIN impacted i ON fi.target_file = i.file_path
          WHERE fi.snapshot_idx = ?
            AND i.hop_distance < 6
            AND NOT list_contains(i.path, fi.source_file)
        )
        SELECT file_path, MIN(hop_distance) AS hop_distance
        FROM impacted
        WHERE file_path != ?
        GROUP BY file_path
        ORDER BY hop_distance ASC, file_path ASC;
        `,
        [snapshotIdx, sourceFile, snapshotIdx, sourceFile],
      ),
      this.runReadSql(
        `
        SELECT snapshot_idx, file_a, file_b, shared_commits, coupling_ratio
        FROM cochange_pairs
        WHERE snapshot_idx = ? AND (file_a = ? OR file_b = ?)
        ORDER BY coupling_ratio DESC, shared_commits DESC
        LIMIT 15;
        `,
        [snapshotIdx, sourceFile, sourceFile],
      ),
    ]);

    return {
      source_file: sourceFile,
      snapshot_idx: snapshotIdx,
      impacted_files: blastRows.map((r) => ({
        file_path: String(r.file_path),
        hop_distance: Number(r.hop_distance),
      })),
      fault_lines: coRows.map(mapCochangeRow),
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
    const rows = await this.runReadSql(
      `
      SELECT snapshot_idx, sloc, hotspot_score, lint_issue_count
      FROM file_metrics
      WHERE file_path = ?
      ORDER BY snapshot_idx ASC;
      `,
      [filePath],
    );
    return rows.map((r) => ({
      snapshot_idx: Number(r.snapshot_idx),
      sloc: Number(r.sloc),
      hotspot_score: Number(r.hotspot_score),
      lint_issue_count: Number(r.lint_issue_count),
    }));
  }

  async queryFileDiagnostics(snapshotIdx: number, filePath: string): Promise<LintDiagnostic[]> {
    const rows = await this.runReadSql(
      `
      SELECT *
      FROM lint_diagnostics
      WHERE snapshot_idx = ? AND file_path = ?
      ORDER BY line ASC, col ASC
      LIMIT 100;
      `,
      [snapshotIdx, filePath],
    );
    return rows.map((r) => ({
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
    }));
  }

  async queryAnnotations(): Promise<Annotation[]> {
    const rows = await this.runReadSql(`SELECT * FROM annotations ORDER BY created_at DESC;`);
    return rows.map((r) => ({
      annotation_id: String(r.annotation_id),
      file_path: String(r.file_path),
      author: String(r.author),
      tag: String(r.tag),
      body: String(r.body),
      created_at: String(r.created_at),
    }));
  }

  private repoBase(owner: string, repo: string): string {
    return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private async requestJson<T>(
    url: string,
    init?: RequestInit,
    errorLabel = "Request failed",
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const resp = await fetch(url, { ...init, headers });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(detail || `${errorLabel} (${resp.status})`);
    }
    return (await resp.json()) as T;
  }

  fetchRepos(): Promise<RepoRef[]> {
    return this.requestJson("/api/repos", undefined, "Failed to fetch repos");
  }

  startAnalyze(
    source: string,
    maxKeyframes = 16,
  ): Promise<{ job_id: string; owner: string; repo: string }> {
    return this.requestJson(
      "/api/analyze",
      { method: "POST", body: JSON.stringify({ source, max_keyframes: maxKeyframes }) },
      "Analyze request failed",
    );
  }

  fetchFixDiff(owner: string, repo: string, filePath: string): Promise<FixDiffResult> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/fix-diff`,
      { method: "POST", body: JSON.stringify({ file_path: filePath }) },
      "Fix diff failed",
    );
  }

  postAnnotation(
    owner: string,
    repo: string,
    payload: { file_path: string; author: string; tag: string; body: string },
  ): Promise<Annotation> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/annotations`,
      { method: "POST", body: JSON.stringify(payload) },
      "Failed to save annotation",
    );
  }

  async fetchAnnotationChanges(owner: string, repo: string): Promise<AnnotationChangeEvent[]> {
    try {
      return await this.requestJson(`${this.repoBase(owner, repo)}/annotations/changes`);
    } catch {
      return [];
    }
  }

  fetchQuackSnippet(owner: string, repo: string): Promise<QuackSnippetInfo> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/quack-snippet`,
      undefined,
      "Failed to fetch quack snippet",
    );
  }

  async fetchAuthors(owner: string, repo: string): Promise<AuthorSummary[]> {
    try {
      return await this.requestJson(`${this.repoBase(owner, repo)}/authors`);
    } catch {
      return [];
    }
  }

  triggerExport(
    owner: string,
    repo: string,
  ): Promise<{ output_dir: string; badge_url: string; postcard_url: string | null }> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/export`,
      { method: "POST", body: JSON.stringify({ with_postcard: true }) },
      "Export failed",
    );
  }

  startLiveMayorSession(
    owner: string,
    repo: string,
  ): Promise<{ branch: string; previous_branch: string; commits: string[] }> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/mayor/session`,
      { method: "POST" },
      "Failed to start Mayor session",
    );
  }

  executeLiveMayorAction(
    owner: string,
    repo: string,
    payload: {
      tool: string;
      target_path: string;
      secondary_path?: string | null;
      district_path?: string;
      confirm?: boolean;
    },
  ): Promise<{
    ok: boolean;
    branch: string;
    tool: string;
    target_path: string;
    committed: boolean;
    commit_sha: string | null;
    diff: string;
    message: string;
  }> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/mayor/execute`,
      { method: "POST", body: JSON.stringify(payload) },
      "Live Mayor action failed",
    );
  }

  async fetchRemoteSandboxActions(owner: string, repo: string): Promise<SandboxActionRecord[]> {
    try {
      return await this.requestJson(`${this.repoBase(owner, repo)}/sandbox-actions`);
    } catch {
      return [];
    }
  }

  pushRemoteSandboxAction(
    owner: string,
    repo: string,
    action: SandboxActionRecord,
  ): Promise<SandboxActionRecord> {
    return this.requestJson(
      `${this.repoBase(owner, repo)}/sandbox-actions`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: action.action_id,
          tool: action.tool,
          target_path: action.target_path,
          secondary_path: action.secondary_path,
          district_path: action.district_path,
          summary: action.summary,
          velocity_cost: action.velocity_cost,
        }),
      },
      "Failed to sync sandbox action",
    );
  }

  async toggleRemoteSandboxAction(
    owner: string,
    repo: string,
    actionId: string,
    active: boolean,
  ): Promise<void> {
    await this.requestJson(
      `${this.repoBase(owner, repo)}/sandbox-actions/${encodeURIComponent(actionId)}/toggle`,
      { method: "POST", body: JSON.stringify({ active }) },
      "Failed to toggle sandbox action",
    );
  }

  async clearRemoteSandboxActions(owner: string, repo: string): Promise<void> {
    await this.requestJson(
      `${this.repoBase(owner, repo)}/sandbox-actions`,
      { method: "DELETE" },
      "Failed to clear sandbox actions",
    );
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
    this.initPromise = null;
    this.loadedKey = null;
    this.sandboxTableReady = false;
  }
}

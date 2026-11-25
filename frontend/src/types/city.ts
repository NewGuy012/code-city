export type ZoneType =
  | "harbor_gates"
  | "downtown_core"
  | "vaults_reservoir"
  | "industrial_quarter"
  | "gallery_storefront"
  | "civic_utilities"
  | "greenbelt_parks"
  | "supply_docks";

export type BuildingArchetype =
  | "grand_terminal"
  | "city_hall"
  | "archive_vault"
  | "twin_silos"
  | "factory"
  | "office_tower"
  | "glass_pavilion"
  | "watchtower"
  | "civic_kiosk"
  | "park_stadium";

export type DataMapMode =
  "living" | "hotspots" | "pollution" | "bus_factor" | "languages" | "format_drift";

export interface SymbolSummary {
  name: string;
  kind: string;
  exported: boolean;
  doc: string;
  complexity: number;
  start_line: number;
  end_line: number;
  methods: string[];
}

export interface BuildingDescription {
  short_summary: string;
  detailed_overview: string;
  responsibilities: string[];
  key_symbols: SymbolSummary[];
  endpoints: string[];
  endpoints_total: number;
  external_packages: string[];
  most_complex_symbol?: { name: string; complexity: number } | null;
  health_notes: string[];
  readme_context?: string | null;
  source: string;
  model?: string | null;
}

export interface DistrictGuide {
  district_path: string;
  display_name: string;
  zone_type: ZoneType;
  plain_label: string;
  summary: string;
  file_count: number;
}

export interface RecommendedStart {
  file_path: string;
  title: string;
  reason: string;
  archetype: BuildingArchetype;
}

export interface CityBriefing {
  repo_name: string;
  headline: string;
  mayor_welcome: string;
  overview: string;
  architecture_summary: string;
  district_guides: DistrictGuide[];
  recommended_starts: RecommendedStart[];
  readme_excerpt?: string | null;
  source: string;
  model?: string | null;
}

export interface FileSourcePayload {
  file_path: string;
  language: string;
  commit_sha: string;
  total_lines: number;
  truncated: boolean;
  content: string;
}

export interface HealthStatus {
  status: string;
  duckdb_version: string;
  quack_enabled: boolean;
  quack_uri: string | null;
  llm_enabled?: boolean;
  llm_provider?: string | null;
  llm_model?: string | null;
  llm_fallback_provider?: string | null;
}

export interface AdvisorAlert {
  severity: "info" | "warn" | "critical" | string;
  icon: string;
  title: string;
  detail: string;
  target_path?: string | null;
}

export interface Snapshot {
  snapshot_idx: number;
  commit_sha: string;
  committed_at: string;
  git_tag: string | null;
  total_files: number;
  total_sloc: number;
  total_lint_issues: number;
  language_breakdown: Record<string, number>;
  health_score: number;
  health_grade: string;
  city_archetype_title: string;
  advisor_alerts: AdvisorAlert[];
  city_briefing?: CityBriefing | null;
}

export interface District {
  snapshot_idx: number;
  district_path: string;
  display_name: string;
  zone_type: ZoneType;
  bounds_x: number;
  bounds_z: number;
  bounds_w: number;
  bounds_d: number;
  file_count: number;
  avg_health: number;
  summary_blurb: string;
}

export interface FileMetric {
  snapshot_idx: number;
  file_path: string;
  district_path: string;
  language: string;
  zone_type: ZoneType;
  building_archetype: BuildingArchetype;
  role_confidence: number;
  role_signals: {
    reasons?: string[];
    description?: BuildingDescription;
    [key: string]: unknown;
  };
  sloc: number;
  symbol_count: number;
  max_complexity: number;
  type_or_doc_ratio: number;
  lint_issue_count: number;
  format_drift: boolean;
  lint_by_category: Record<string, number>;
  churn_90d: number;
  bugfix_commits_90d: number;
  distinct_authors_90d: number;
  hotspot_score: number;
  condition_flags: {
    crane?: boolean;
    smog?: boolean;
    lone_keeper?: boolean;
    format_drift?: boolean;
    high_complexity?: boolean;
    [key: string]: unknown;
  };
  layout_x: number;
  layout_z: number;
  layout_w: number;
  layout_d: number;
}

export interface FileImport {
  snapshot_idx: number;
  source_file: string;
  target_file: string;
}

export interface CochangePair {
  snapshot_idx: number;
  file_a: string;
  file_b: string;
  shared_commits: number;
  coupling_ratio: number;
}

export interface ExternalDep {
  snapshot_idx: number;
  ecosystem: string;
  package_name: string;
  version: string;
  is_direct: boolean;
}

export interface LintDiagnostic {
  snapshot_idx: number;
  file_path: string;
  linter: string;
  line: number;
  col: number;
  rule_code: string;
  category: string;
  message: string;
  fixable: boolean;
  metadata: Record<string, unknown>;
}

export interface Annotation {
  annotation_id: string;
  file_path: string;
  author: string;
  tag: string;
  body: string;
  created_at: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
  schema_path: string;
  repo_url_or_path: string;
  latest_snapshot_idx: number;
  latest_grade: string;
  latest_title: string;
  total_snapshots: number;
  total_files: number;
}

export interface BlastRadiusNode {
  file_path: string;
  hop_distance: number;
}

export interface BlastRadiusResult {
  source_file: string;
  snapshot_idx: number;
  impacted_files: BlastRadiusNode[];
  fault_lines: CochangePair[];
}

export interface StaticManifest {
  mode: "static";
  owner: string;
  repo: string;
  source: string;
  generated_at: string;
}

export interface AuthorSummary {
  author: string;
  sole_files: string[];
  total_files: number;
}

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
  role_signals: Record<string, unknown>;
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
  parent_package: string | null;
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
  district_path: string;
  building_archetype: BuildingArchetype;
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

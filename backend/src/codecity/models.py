"""Pydantic v2 domain models and DuckLake schema contracts for CodeCity."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class ZoneType(StrEnum):
    """SimCity district zone types mapped from directory subtrees."""

    HARBOR_GATES = "harbor_gates"
    DOWNTOWN_CORE = "downtown_core"
    VAULTS_RESERVOIR = "vaults_reservoir"
    INDUSTRIAL_QUARTER = "industrial_quarter"
    GALLERY_STOREFRONT = "gallery_storefront"
    CIVIC_UTILITIES = "civic_utilities"
    GREENBELT_PARKS = "greenbelt_parks"
    SUPPLY_DOCKS = "supply_docks"


class BuildingArchetype(StrEnum):
    """Ten stylized architectural silhouettes representing module roles."""

    GRAND_TERMINAL = "grand_terminal"
    CITY_HALL = "city_hall"
    ARCHIVE_VAULT = "archive_vault"
    TWIN_SILOS = "twin_silos"
    FACTORY = "factory"
    OFFICE_TOWER = "office_tower"
    GLASS_PAVILION = "glass_pavilion"
    WATCHTOWER = "watchtower"
    CIVIC_KIOSK = "civic_kiosk"
    PARK_STADIUM = "park_stadium"


class SymbolSummary(BaseModel):
    """Compact summary of an exported or top-level code symbol."""

    name: str
    kind: str
    exported: bool = True
    doc: str = ""
    complexity: int = 1
    start_line: int = 1
    end_line: int = 1
    methods: list[str] = Field(default_factory=list)


class BuildingDescription(BaseModel):
    """Human-friendly + technical description for a single file/building."""

    short_summary: str
    detailed_overview: str
    responsibilities: list[str] = Field(default_factory=list)
    key_symbols: list[SymbolSummary] = Field(default_factory=list)
    endpoints: list[str] = Field(default_factory=list)
    endpoints_total: int = 0
    external_packages: list[str] = Field(default_factory=list)
    most_complex_symbol: dict[str, Any] | None = None
    health_notes: list[str] = Field(default_factory=list)
    readme_context: str | None = None
    source: str = "ast"
    model: str | None = None


class DistrictGuide(BaseModel):
    """Plain-English guide card for one neighborhood district."""

    district_path: str
    display_name: str
    zone_type: ZoneType
    plain_label: str
    summary: str
    file_count: int = 0


class RecommendedStart(BaseModel):
    """Curated starting building for onboarding a new teammate."""

    file_path: str
    title: str
    reason: str
    archetype: BuildingArchetype


class CityBriefing(BaseModel):
    """High-level Mayor's welcome briefing explaining what the codebase does."""

    repo_name: str
    headline: str
    mayor_welcome: str
    overview: str
    architecture_summary: str = ""
    district_guides: list[DistrictGuide] = Field(default_factory=list)
    recommended_starts: list[RecommendedStart] = Field(default_factory=list)
    readme_excerpt: str | None = None
    source: str = "ast"
    model: str | None = None


class AdvisorAlert(BaseModel):
    severity: str = Field(description="info | warn | critical")
    icon: str
    title: str
    detail: str
    target_path: str | None = None


class Snapshot(BaseModel):
    snapshot_idx: int
    commit_sha: str
    committed_at: datetime
    git_tag: str | None = None
    total_files: int = 0
    total_sloc: int = 0
    total_lint_issues: int = 0
    language_breakdown: dict[str, int] = Field(default_factory=dict)
    health_score: float = 100.0
    health_grade: str = "A"
    city_archetype_title: str = "Sunlit Civic Metropolis"
    advisor_alerts: list[AdvisorAlert] = Field(default_factory=list)
    city_briefing: CityBriefing | None = None


class District(BaseModel):
    snapshot_idx: int
    district_path: str
    display_name: str
    zone_type: ZoneType
    bounds_x: float
    bounds_z: float
    bounds_w: float
    bounds_d: float
    file_count: int = 0
    avg_health: float = 100.0
    summary_blurb: str = ""


class FileMetric(BaseModel):
    snapshot_idx: int
    file_path: str
    district_path: str
    language: str
    zone_type: ZoneType
    building_archetype: BuildingArchetype
    role_confidence: float = 0.75
    role_signals: dict[str, Any] = Field(default_factory=dict)
    sloc: int = 0
    symbol_count: int = 0
    max_complexity: int = 1
    type_or_doc_ratio: float = 0.0
    lint_issue_count: int = 0
    format_drift: bool = False
    lint_by_category: dict[str, int] = Field(default_factory=dict)
    churn_90d: int = 0
    bugfix_commits_90d: int = 0
    distinct_authors_90d: int = 0
    hotspot_score: float = 0.0
    condition_flags: dict[str, Any] = Field(default_factory=dict)
    layout_x: float = 0.0
    layout_z: float = 0.0
    layout_w: float = 1.0
    layout_d: float = 1.0


class FileImport(BaseModel):
    snapshot_idx: int
    source_file: str
    target_file: str


class CochangePair(BaseModel):
    snapshot_idx: int
    file_a: str
    file_b: str
    shared_commits: int
    coupling_ratio: float


class ExternalDep(BaseModel):
    snapshot_idx: int
    ecosystem: str
    package_name: str
    version: str = ""
    is_direct: bool = True


class LintDiagnostic(BaseModel):
    snapshot_idx: int
    file_path: str
    linter: str
    line: int
    col: int
    rule_code: str
    category: str
    message: str
    fixable: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class Annotation(BaseModel):
    annotation_id: str
    file_path: str
    author: str
    tag: str = "note"
    body: str
    created_at: datetime


class RepoRef(BaseModel):
    owner: str
    repo: str
    schema_path: str
    repo_url_or_path: str
    latest_snapshot_idx: int = 0
    latest_grade: str = "A"
    latest_title: str = "Sunlit Civic Metropolis"
    total_snapshots: int = 0
    total_files: int = 0


class FixDiffResult(BaseModel):
    file_path: str
    linter: str
    has_changes: bool
    diff: str
    message: str = ""


class AnalyzeRequest(BaseModel):
    source: str
    owner: str | None = None
    repo: str | None = None
    max_keyframes: int = Field(default=16, ge=1, le=120)
    semantic: bool = True
    llm_mode: str = Field(default="auto", pattern=r"^(auto|head|lazy|off)$")
    workers: int = Field(default=4, ge=1, le=16)


class SandboxAction(BaseModel):
    action_id: str
    action_seq: int = 1
    session_id: str = "default"
    author: str = "mayor"
    tool: str
    target_path: str
    secondary_path: str | None = None
    district_path: str
    summary: str
    velocity_cost: int = 0
    active: bool = True
    created_at: datetime

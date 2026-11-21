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


class AdvisorAlert(BaseModel):
    """Contextual SimCity City Advisor alert derived from codebase metrics."""

    severity: str = Field(description="info | warn | critical")
    icon: str
    title: str
    detail: str
    target_path: str | None = None


class Snapshot(BaseModel):
    """Repository point-in-time snapshot stored in DuckLake."""

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


class District(BaseModel):
    """Zoned directory neighborhood with 2D/3D layout bounds."""

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
    """Per-file building metric, archetype classification, and city grid placement."""

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
    """Directed module import dependency edge."""

    snapshot_idx: int
    source_file: str
    target_file: str


class CochangePair(BaseModel):
    """Temporal co-change coupling between two files in Git history."""

    snapshot_idx: int
    file_a: str
    file_b: str
    shared_commits: int
    coupling_ratio: float


class ExternalDep(BaseModel):
    """External supply dock dependency parsed from lockfiles/manifests."""

    snapshot_idx: int
    ecosystem: str
    package_name: str
    version: str = ""
    is_direct: bool = True
    parent_package: str | None = None


class LintDiagnostic(BaseModel):
    """Normalized linter/formatter diagnostic item."""

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
    """Collaborative Mayor Note stored in DuckLake with Data Inlining."""

    annotation_id: str
    file_path: str
    author: str
    tag: str = "note"
    body: str
    created_at: datetime


class RepoRef(BaseModel):
    """Identified repository stored under nested DuckLake schema `repos.<owner>.<repo>`."""

    owner: str
    repo: str
    schema_path: str
    repo_url_or_path: str
    latest_snapshot_idx: int = 0
    latest_grade: str = "A"
    latest_title: str = "Sunlit Civic Metropolis"
    total_snapshots: int = 0
    total_files: int = 0


class BlastRadiusNode(BaseModel):
    """Impacted building in a Power-Outage Blast Radius simulation."""

    file_path: str
    hop_distance: int
    district_path: str
    building_archetype: BuildingArchetype


class BlastRadiusResult(BaseModel):
    """Direct + transitive dependents and hidden temporal co-change fault lines."""

    source_file: str
    snapshot_idx: int
    impacted_files: list[BlastRadiusNode] = Field(default_factory=list)
    fault_lines: list[CochangePair] = Field(default_factory=list)


class FixDiffResult(BaseModel):
    """Live auto-fix preview generated by ruff or bun lint --fix."""

    file_path: str
    linter: str
    has_changes: bool
    diff: str
    fixed_content: str | None = None
    message: str = ""


class AnalyzeRequest(BaseModel):
    """Request payload for starting repository ingestion."""

    source: str
    owner: str | None = None
    repo: str | None = None
    max_keyframes: int = Field(default=16, ge=1, le=120)
    semantic: bool = False
    workers: int = Field(default=4, ge=1, le=16)


class SandboxAction(BaseModel):
    """Multiplayer Sandbox Mayor intervention persisted in DuckLake over Quack."""

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

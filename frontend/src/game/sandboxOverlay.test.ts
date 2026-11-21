import { describe, expect, test } from "bun:test";
import type { CitySnapshotBundle } from "../data/cityDataClient";
import type { FileMetric } from "../types/city";
import {
  type SandboxActionRecord,
  applySandboxOverlay,
  generateRefactorBlueprintMarkdown,
  validateToolOnFile,
} from "./sandboxOverlay";

function makeSampleBundle(): CitySnapshotBundle {
  const files: FileMetric[] = [
    {
      snapshot_idx: 0,
      file_path: "core/monolith.py",
      district_path: "core",
      language: "python",
      zone_type: "downtown_core",
      building_archetype: "city_hall",
      role_confidence: 0.9,
      role_signals: {},
      sloc: 520,
      symbol_count: 16,
      max_complexity: 20,
      type_or_doc_ratio: 0.5,
      lint_issue_count: 6,
      format_drift: true,
      lint_by_category: { style: 6 },
      churn_90d: 14,
      bugfix_commits_90d: 3,
      distinct_authors_90d: 1,
      hotspot_score: 26,
      condition_flags: { smog: true, lone_keeper: true, fan_in: 2 },
      layout_x: 20,
      layout_z: 20,
      layout_w: 12,
      layout_d: 8,
    },
    {
      snapshot_idx: 0,
      file_path: "core/helper.py",
      district_path: "core",
      language: "python",
      zone_type: "downtown_core",
      building_archetype: "office_tower",
      role_confidence: 0.85,
      role_signals: {},
      sloc: 90,
      symbol_count: 3,
      max_complexity: 4,
      type_or_doc_ratio: 0.8,
      lint_issue_count: 0,
      format_drift: false,
      lint_by_category: {},
      churn_90d: 2,
      bugfix_commits_90d: 0,
      distinct_authors_90d: 2,
      hotspot_score: 1,
      condition_flags: {},
      layout_x: 34,
      layout_z: 20,
      layout_w: 6,
      layout_d: 6,
    },
    {
      snapshot_idx: 0,
      file_path: "core/unused.py",
      district_path: "core",
      language: "python",
      zone_type: "downtown_core",
      building_archetype: "civic_kiosk",
      role_confidence: 0.7,
      role_signals: {},
      sloc: 45,
      symbol_count: 1,
      max_complexity: 1,
      type_or_doc_ratio: 0.5,
      lint_issue_count: 2,
      format_drift: false,
      lint_by_category: {},
      churn_90d: 0,
      bugfix_commits_90d: 0,
      distinct_authors_90d: 1,
      hotspot_score: 0.7,
      condition_flags: {},
      layout_x: 42,
      layout_z: 20,
      layout_w: 5,
      layout_d: 5,
    },
  ];
  return {
    snapshot: {
      snapshot_idx: 0,
      commit_sha: "deadbeef",
      committed_at: "2026-06-01T00:00:00Z",
      git_tag: null,
      total_files: 3,
      total_sloc: 655,
      total_lint_issues: 8,
      language_breakdown: { python: 3 },
      health_score: 64,
      health_grade: "C+",
      city_archetype_title: "High-Voltage Refactor Zone",
      advisor_alerts: [],
    },
    districts: [
      {
        snapshot_idx: 0,
        district_path: "core",
        display_name: "core",
        zone_type: "downtown_core",
        bounds_x: 16,
        bounds_z: 16,
        bounds_w: 36,
        bounds_d: 22,
        file_count: 3,
        avg_health: 68,
        summary_blurb: "",
      },
    ],
    files,
    imports: [
      { snapshot_idx: 0, source_file: "core/monolith.py", target_file: "core/helper.py" },
      { snapshot_idx: 0, source_file: "core/helper.py", target_file: "core/monolith.py" },
    ],
    cochanges: [],
    deps: [],
  };
}

describe("sandboxOverlay Mayor tools", () => {
  test("validates tool eligibility and transforms city metrics cleanly", () => {
    const base = makeSampleBundle();
    const monolith = base.files[0];
    const helper = base.files[1];
    const unused = base.files[2];

    expect(validateToolOnFile("splitter", helper, base, null).ok).toBe(false);
    expect(validateToolOnFile("splitter", monolith, base, null).ok).toBe(true);
    expect(validateToolOnFile("bulldozer", monolith, base, null).ok).toBe(false);
    expect(validateToolOnFile("bulldozer", unused, base, null).ok).toBe(true);

    const actions: SandboxActionRecord[] = [
      {
        action_id: "1",
        action_seq: 1,
        tool: "sweeper",
        target_path: "core/monolith.py",
        secondary_path: null,
        district_path: "core",
        summary: "Cleared lint smog",
        velocity_cost: 10,
        active: true,
        created_at: "2026-06-01T00:00:00Z",
      },
      {
        action_id: "2",
        action_seq: 2,
        tool: "co_maintainer",
        target_path: "core/monolith.py",
        secondary_path: null,
        district_path: "core",
        summary: "Assigned co-maintainer",
        velocity_cost: 15,
        active: true,
        created_at: "2026-06-01T00:01:00Z",
      },
      {
        action_id: "3",
        action_seq: 3,
        tool: "transit_hub",
        target_path: "core/monolith.py",
        secondary_path: "core/helper.py",
        district_path: "core",
        summary: "Inserted Interface Hub",
        velocity_cost: 30,
        active: true,
        created_at: "2026-06-01T00:02:00Z",
      },
      {
        action_id: "4",
        action_seq: 4,
        tool: "splitter",
        target_path: "core/monolith.py",
        secondary_path: null,
        district_path: "core",
        summary: "Split monolith",
        velocity_cost: 35,
        active: true,
        created_at: "2026-06-01T00:03:00Z",
      },
      {
        action_id: "5",
        action_seq: 5,
        tool: "proving_park",
        target_path: "core/helper.py",
        secondary_path: null,
        district_path: "core",
        summary: "Planted Proving Park",
        velocity_cost: 25,
        active: true,
        created_at: "2026-06-01T00:04:00Z",
      },
      {
        action_id: "6",
        action_seq: 6,
        tool: "bulldozer",
        target_path: "core/unused.py",
        secondary_path: null,
        district_path: "core",
        summary: "Demolished dead code",
        velocity_cost: 5,
        active: true,
        created_at: "2026-06-01T00:05:00Z",
      },
    ];

    const res = applySandboxOverlay(base, actions);
    expect(res.protectedDistricts.has("core")).toBe(true);
    expect(res.demolishedLots.length).toBe(1);
    expect(res.bundle.files.some((f) => f.file_path === "core/unused.py")).toBe(false);
    expect(res.bundle.files.some((f) => f.file_path.includes("_core.py"))).toBe(true);
    expect(res.bundle.files.some((f) => f.building_archetype === "park_stadium")).toBe(true);
    expect(res.bundle.files.some((f) => f.building_archetype === "civic_kiosk")).toBe(true);
    expect(res.bundle.snapshot.health_score).toBeGreaterThan(base.snapshot.health_score);

    const md = generateRefactorBlueprintMarkdown("acme/demo", actions, base, res.bundle);
    expect(md).toContain("Mayor's Refactor Blueprint — acme/demo");
    expect(md).toContain("[SPLITTER]");
    expect(md).toContain("[BULLDOZER]");
  });
});

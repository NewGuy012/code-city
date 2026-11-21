import { describe, expect, test } from "bun:test";
import type { CitySnapshotBundle } from "../data/cityDataClient";
import type { District, FileMetric } from "../types/city";
import { buildRoadGraph, detectImportCycles, findStreetPath } from "./roadGraph";
import { CitySimulationEngine } from "./simEngine";

function makeTestBundle(): CitySnapshotBundle {
  const districts: District[] = [
    {
      snapshot_idx: 0,
      district_path: "api",
      display_name: "api",
      zone_type: "harbor_gates",
      bounds_x: 10,
      bounds_z: 60,
      bounds_w: 35,
      bounds_d: 35,
      file_count: 1,
      avg_health: 90,
      summary_blurb: "",
    },
    {
      snapshot_idx: 0,
      district_path: "core",
      display_name: "core",
      zone_type: "downtown_core",
      bounds_x: 55,
      bounds_z: 20,
      bounds_w: 35,
      bounds_d: 35,
      file_count: 2,
      avg_health: 75,
      summary_blurb: "",
    },
    {
      snapshot_idx: 0,
      district_path: "db",
      display_name: "db",
      zone_type: "vaults_reservoir",
      bounds_x: 100,
      bounds_z: 20,
      bounds_w: 30,
      bounds_d: 35,
      file_count: 1,
      avg_health: 88,
      summary_blurb: "",
    },
  ];
  const files: FileMetric[] = [
    {
      snapshot_idx: 0,
      file_path: "api/routes.py",
      district_path: "api",
      language: "python",
      zone_type: "harbor_gates",
      building_archetype: "grand_terminal",
      role_confidence: 0.9,
      role_signals: {},
      sloc: 80,
      symbol_count: 4,
      max_complexity: 3,
      type_or_doc_ratio: 0.8,
      lint_issue_count: 0,
      format_drift: false,
      lint_by_category: {},
      churn_90d: 3,
      bugfix_commits_90d: 0,
      distinct_authors_90d: 2,
      hotspot_score: 2,
      condition_flags: {},
      layout_x: 14,
      layout_z: 64,
      layout_w: 10,
      layout_d: 10,
    },
    {
      snapshot_idx: 0,
      file_path: "core/hub.py",
      district_path: "core",
      language: "python",
      zone_type: "downtown_core",
      building_archetype: "city_hall",
      role_confidence: 0.9,
      role_signals: {},
      sloc: 500,
      symbol_count: 18,
      max_complexity: 18,
      type_or_doc_ratio: 0.6,
      lint_issue_count: 4,
      format_drift: true,
      lint_by_category: {},
      churn_90d: 12,
      bugfix_commits_90d: 3,
      distinct_authors_90d: 1,
      hotspot_score: 24,
      condition_flags: { smog: true, lone_keeper: true, fan_in: 5 },
      layout_x: 58,
      layout_z: 24,
      layout_w: 14,
      layout_d: 14,
    },
    {
      snapshot_idx: 0,
      file_path: "core/worker.py",
      district_path: "core",
      language: "python",
      zone_type: "downtown_core",
      building_archetype: "office_tower",
      role_confidence: 0.8,
      role_signals: {},
      sloc: 120,
      symbol_count: 5,
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
      layout_x: 74,
      layout_z: 24,
      layout_w: 10,
      layout_d: 10,
    },
    {
      snapshot_idx: 0,
      file_path: "db/store.py",
      district_path: "db",
      language: "python",
      zone_type: "vaults_reservoir",
      building_archetype: "twin_silos",
      role_confidence: 0.9,
      role_signals: {},
      sloc: 90,
      symbol_count: 4,
      max_complexity: 2,
      type_or_doc_ratio: 0.9,
      lint_issue_count: 0,
      format_drift: false,
      lint_by_category: {},
      churn_90d: 1,
      bugfix_commits_90d: 0,
      distinct_authors_90d: 2,
      hotspot_score: 0.5,
      condition_flags: {},
      layout_x: 104,
      layout_z: 24,
      layout_w: 10,
      layout_d: 10,
    },
  ];
  return {
    snapshot: {
      snapshot_idx: 0,
      commit_sha: "abc1234",
      committed_at: "2026-06-01T00:00:00Z",
      git_tag: "v0.1.0",
      total_files: files.length,
      total_sloc: 790,
      total_lint_issues: 4,
      language_breakdown: { python: 4 },
      health_score: 78,
      health_grade: "B+",
      city_archetype_title: "Bustling Harbor District",
      advisor_alerts: [],
    },
    districts,
    files,
    imports: [
      { snapshot_idx: 0, source_file: "api/routes.py", target_file: "core/hub.py" },
      { snapshot_idx: 0, source_file: "core/hub.py", target_file: "core/worker.py" },
      { snapshot_idx: 0, source_file: "core/worker.py", target_file: "core/hub.py" },
      { snapshot_idx: 0, source_file: "core/hub.py", target_file: "db/store.py" },
    ],
    cochanges: [],
    deps: [
      {
        snapshot_idx: 0,
        ecosystem: "python",
        package_name: "fastapi",
        version: "0.115",
        is_direct: true,
        parent_package: null,
      },
    ],
  };
}

describe("roadGraph & simEngine", () => {
  test("A* street pathfinding and cycle detection work over road graph", () => {
    const bundle = makeTestBundle();
    const graph = buildRoadGraph(bundle.districts, bundle.files, bundle.imports);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.bottleneckFilePaths.has("core/hub.py")).toBe(true);

    const startId = graph.fileToNode.get("api/routes.py")!;
    const goalId = graph.fileToNode.get("db/store.py")!;
    const path = findStreetPath(graph, startId, goalId);
    expect(path.waypoints.length).toBeGreaterThanOrEqual(2);

    const cycles = detectImportCycles(bundle.imports);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain("core/hub.py");
    expect(cycles[0]).toContain("core/worker.py");
  });

  test("10Hz simulation steps traffic, sprint treasury, and service vehicles", () => {
    const bundle = makeTestBundle();
    const engine = new CitySimulationEngine();
    const initial = engine.step(bundle);
    expect(initial.vehicles.length).toBeGreaterThan(0);
    expect(initial.cycleCount).toBe(1);

    const startTreasury = initial.velocityTreasury;
    for (let i = 0; i < 45; i++) {
      engine.step(bundle);
    }
    const later = engine.getSnapshot();
    expect(later.sprintNumber).toBe(2);
    expect(later.velocityTreasury).not.toBe(startTreasury);

    const veh = engine.getFollowedVehicle("auto");
    expect(veh).not.toBeNull();

    engine.dispatchServiceUnit("sweeper", bundle.files[1], bundle);
    expect(engine.getSnapshot().vehicles.some((v) => v.type === "sweeper")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type { CityDataClient, CitySnapshotBundle } from "../data/cityDataClient";
import type { BuildingArchetype, District, FileMetric, ZoneType } from "../types/city";
import { evaluateAdvisorMissions } from "./missions";
import { buildRoadGraph, detectImportCycles, findStreetPath } from "./roadGraph";
import {
  type SandboxActionRecord,
  appendSandboxAction,
  applySandboxOverlay,
  generateRefactorBlueprintMarkdown,
  redoSandboxAction,
  undoSandboxAction,
  validateToolOnFile,
} from "./sandboxOverlay";
import { CitySimulationEngine, computeImpactedFiles } from "./simEngine";
import { soundEngine } from "./soundEngine";

function makeFile(
  file_path: string,
  district_path: string,
  zone_type: ZoneType,
  building_archetype: BuildingArchetype,
  overrides: Partial<FileMetric> = {},
): FileMetric {
  return {
    snapshot_idx: 0,
    file_path,
    district_path,
    language: "python",
    zone_type,
    building_archetype,
    role_confidence: 0.9,
    role_signals: {},
    sloc: 90,
    symbol_count: 4,
    max_complexity: 3,
    type_or_doc_ratio: 0.8,
    lint_issue_count: 0,
    format_drift: false,
    lint_by_category: {},
    churn_90d: 2,
    bugfix_commits_90d: 0,
    distinct_authors_90d: 2,
    hotspot_score: 1,
    condition_flags: {},
    layout_x: 20,
    layout_z: 20,
    layout_w: 8,
    layout_d: 8,
    ...overrides,
  };
}

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
      file_count: 3,
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
    makeFile("api/routes.py", "api", "harbor_gates", "grand_terminal", {
      sloc: 80,
      layout_x: 14,
      layout_z: 64,
    }),
    makeFile("core/hub.py", "core", "downtown_core", "city_hall", {
      sloc: 520,
      symbol_count: 18,
      max_complexity: 20,
      lint_issue_count: 6,
      format_drift: true,
      churn_90d: 14,
      bugfix_commits_90d: 3,
      distinct_authors_90d: 1,
      hotspot_score: 26,
      condition_flags: { smog: true, lone_keeper: true, fan_in: 5 },
      layout_x: 58,
      layout_z: 24,
      layout_w: 14,
      layout_d: 12,
    }),
    makeFile("core/worker.py", "core", "downtown_core", "office_tower", {
      sloc: 120,
      layout_x: 74,
      layout_z: 24,
    }),
    makeFile("core/unused.py", "core", "downtown_core", "civic_kiosk", {
      sloc: 45,
      symbol_count: 1,
      max_complexity: 1,
      lint_issue_count: 2,
      churn_90d: 0,
      distinct_authors_90d: 1,
      hotspot_score: 0.7,
      layout_x: 60,
      layout_z: 40,
      layout_w: 5,
      layout_d: 5,
    }),
    makeFile("db/store.py", "db", "vaults_reservoir", "twin_silos", {
      layout_x: 104,
      layout_z: 24,
    }),
  ];
  return {
    snapshot: {
      snapshot_idx: 0,
      commit_sha: "abc1234",
      committed_at: "2026-06-01T00:00:00Z",
      git_tag: "v0.1.0",
      total_files: files.length,
      total_sloc: 855,
      total_lint_issues: 8,
      language_breakdown: { python: files.length },
      health_score: 68,
      health_grade: "B",
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
      },
    ],
  };
}

describe("CodeCity simulation & Mayor sandbox", () => {
  test("validates Mayor tools, transforms city metrics, and exports blueprint", () => {
    const base = makeTestBundle();
    const hub = base.files[1];
    const worker = base.files[2];
    const unused = base.files[3];

    expect(validateToolOnFile("splitter", worker, base, null).ok).toBe(false);
    expect(validateToolOnFile("splitter", hub, base, null).ok).toBe(true);
    expect(validateToolOnFile("bulldozer", hub, base, null).ok).toBe(false);
    expect(validateToolOnFile("bulldozer", unused, base, null).ok).toBe(true);

    const makeAct = (
      seq: number,
      tool: SandboxActionRecord["tool"],
      target_path: string,
      secondary_path: string | null = null,
    ): SandboxActionRecord => ({
      action_id: String(seq),
      action_seq: seq,
      tool,
      target_path,
      secondary_path,
      district_path: "core",
      summary: tool,
      velocity_cost: 10,
      active: true,
      created_at: "2026-06-01T00:00:00Z",
    });

    const actions: SandboxActionRecord[] = [
      makeAct(1, "sweeper", "core/hub.py"),
      makeAct(2, "co_maintainer", "core/hub.py"),
      makeAct(3, "transit_hub", "core/hub.py", "core/worker.py"),
      makeAct(4, "splitter", "core/hub.py"),
      makeAct(5, "proving_park", "core/worker.py"),
      makeAct(6, "bulldozer", "core/unused.py"),
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

    let list = appendSandboxAction([], {
      tool: "sweeper",
      target_path: "core/hub.py",
      secondary_path: null,
      district_path: "core",
      summary: "clean",
      velocity_cost: 10,
    });
    list = appendSandboxAction(list, {
      tool: "proving_park",
      target_path: "core/worker.py",
      secondary_path: null,
      district_path: "core",
      summary: "park",
      velocity_cost: 25,
    });
    expect(list.map((a) => a.action_seq)).toEqual([1, 2]);
    list = undoSandboxAction(list);
    expect(list.map((a) => a.active)).toEqual([true, false]);
    list = redoSandboxAction(list);
    expect(list.map((a) => a.active)).toEqual([true, true]);
    list = undoSandboxAction(list);
    list = appendSandboxAction(list, {
      tool: "co_maintainer",
      target_path: "core/hub.py",
      secondary_path: null,
      district_path: "core",
      summary: "co",
      velocity_cost: 15,
    });
    expect(list.length).toBe(2);
    expect(list[1].tool).toBe("co_maintainer");
  });

  test("A* road graph, 10Hz economy simulation, disasters, and advisor missions", async () => {
    const bundle = makeTestBundle();
    const graph = buildRoadGraph(bundle.districts, bundle.files, bundle.imports);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.bottleneckFilePaths.has("core/hub.py")).toBe(true);

    const path = findStreetPath(
      graph,
      graph.fileToNode.get("api/routes.py")!,
      graph.fileToNode.get("db/store.py")!,
    );
    expect(path.waypoints.length).toBeGreaterThanOrEqual(2);

    const cycles = detectImportCycles(bundle.imports);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toContain("core/hub.py");

    const engine = new CitySimulationEngine();
    const initial = engine.step(bundle);
    expect(initial.vehicles.length).toBeGreaterThan(0);
    expect(initial.cycleCount).toBe(1);

    const startTreasury = initial.velocityTreasury;
    for (let i = 0; i < 45; i++) engine.step(bundle);
    const later = engine.getSnapshot();
    expect(later.sprintNumber).toBe(2);
    expect(later.velocityTreasury).not.toBe(startTreasury);
    expect(engine.getFollowedVehicle("auto")).not.toBeNull();

    engine.dispatchServiceUnit("sweeper", bundle.files[1], bundle);
    expect(engine.getSnapshot().vehicles.some((v) => v.type === "sweeper")).toBe(true);

    expect(computeImpactedFiles("db/store.py", bundle.imports).sort()).toEqual([
      "api/routes.py",
      "core/hub.py",
      "core/worker.py",
    ]);

    engine.triggerPowerOutage("core/hub.py", ["api/routes.py"], new Set());
    expect(engine.getSnapshot().blackoutFiles.has("api/routes.py")).toBe(true);
    engine.triggerCrunchStorm(bundle);
    expect(engine.getSnapshot().fireFiles.size).toBeGreaterThan(0);
    engine.triggerBusFactorVacation("alice", ["core/hub.py"]);
    expect(engine.getSnapshot().activeDisaster?.kind).toBe("bus_factor_vacation");
    engine.triggerSupplyDockStorm("fastapi", bundle);
    expect(engine.getSnapshot().activeDisaster?.kind).toBe("supply_dock_storm");
    engine.clearDisaster();
    expect(engine.getSnapshot().activeDisaster).toBeNull();

    // Passing a new bundle reference with identical file count recomputes cached graph stats
    const cleanBundle: CitySnapshotBundle = {
      ...bundle,
      imports: [],
      files: bundle.files.map((f) => ({
        ...f,
        lint_issue_count: 0,
        max_complexity: 2,
      })),
    };
    expect(later.upkeepPerSprint).toBeGreaterThan(0);
    expect(engine.step(cleanBundle).upkeepPerSprint).toBe(0);

    const dummyClient = { runReadSql: async () => [] } as unknown as CityDataClient;
    const missions = await evaluateAdvisorMissions(dummyClient, bundle);
    expect(missions.length).toBe(4);
    expect(missions.some((m) => m.id === "transit" && !m.completed)).toBe(true);

    soundEngine.playTool("sweeper");
    soundEngine.playMilestone();
    soundEngine.playDisaster();
  });

  test("stepAmbient moves vehicles and notifies render subscribers without HUD or economy churn", () => {
    const bundle = makeTestBundle();
    const engine = new CitySimulationEngine();
    let renderCount = 0;
    const unsub = engine.subscribeRender(() => {
      renderCount++;
    });

    const hudV0 = engine.getHudVersion();
    engine.stepAmbient(bundle);
    const first = engine.getSnapshot();
    const frame1 = engine.getRenderFrame();
    expect(first.vehicles.length).toBeGreaterThan(0);
    expect(first.tick).toBe(0);
    expect(first.sprintNumber).toBe(1);
    expect(first.sprintProgress).toBe(0);

    const initialPositions = first.vehicles.map(
      (v) => `${v.id}:${v.x.toFixed(3)},${v.z.toFixed(3)}`,
    );

    for (let i = 0; i < 45; i++) {
      engine.stepAmbient(bundle);
    }
    const frame2 = engine.getRenderFrame();
    const latest = engine.getSnapshot();
    const afterPositions = latest.vehicles.map(
      (v) => `${v.id}:${v.x.toFixed(3)},${v.z.toFixed(3)}`,
    );
    expect(renderCount).toBe(46);
    expect(engine.getHudVersion()).toBe(hudV0);
    expect(frame1.fireFiles).toBe(frame2.fireFiles);
    expect(frame1.blackoutFiles).toBe(frame2.blackoutFiles);
    expect(afterPositions).not.toEqual(initialPositions);
    expect(latest.tick).toBe(0);
    expect(latest.sprintNumber).toBe(1);
    expect(latest.velocityTreasury).toBe(first.velocityTreasury);
    expect(latest.happiness).toBe(first.happiness);
    expect(latest.milestoneEvent).toBeNull();

    engine.spawnFloatingPopup(10, 10, "test");
    expect(engine.getSnapshot().floatingPopups.length).toBe(1);
    engine.clearFloatingPopups();
    expect(engine.getSnapshot().floatingPopups.length).toBe(0);

    engine.triggerPowerOutage("core/hub.py", ["api/routes.py"], new Set());
    expect(engine.getSnapshot().blackoutFiles).toBe(engine.getSnapshot().blackoutFiles);
    expect(engine.getHudVersion()).toBeGreaterThan(hudV0);

    unsub();
    for (let i = 0; i < 45; i++) {
      engine.step(bundle);
    }
    expect(renderCount).toBe(49);
    expect(engine.getSnapshot().tick).toBe(45);
    expect(engine.getSnapshot().sprintNumber).toBe(2);
    expect(engine.getSnapshot().velocityTreasury).not.toBe(first.velocityTreasury);
  });
});

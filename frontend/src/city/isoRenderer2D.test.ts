import { describe, expect, test } from "bun:test";
import { computeHudMetrics, getHudShellStyle } from "../components/hudPopover";
import type { District, FileMetric } from "../types/city";
import {
  DEFAULT_PITCH,
  DEFAULT_YAW,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
  computeMouseYaw,
} from "./cameraStore";
import {
  ZONE_PALETTES,
  buildingPalette,
  buildingVariantIndex,
  canvasCursorClass,
  isAnalyticalDataMap,
  selectFaultLines,
} from "./cityTheme";
import { computeSliceHeights, getPartGeometry, lotOrientation } from "./geometries3D";
import {
  computeNatureAndStreetPlacements,
  islandElevation,
  islandSignedDist,
} from "./islandLayout";
import {
  cameraFromTarget,
  renderStaticCityLayer,
  screenToWorldGround,
  worldToIso,
  worldToScreen,
} from "./isoRenderer2D";

describe("isoRenderer2D projection", () => {
  test("worldToScreen and screenToWorldGround invert cleanly", () => {
    const cam = { panX: 25, panY: -15, zoom: 1.35 };
    const screen = worldToScreen(42, 68, 0, 1280, 720, cam);
    const back = screenToWorldGround(screen.x, screen.y, 1280, 720, cam);
    expect(Math.abs(back.x - 42)).toBeLessThan(1e-6);
    expect(Math.abs(back.z - 68)).toBeLessThan(1e-6);
  });

  test("worldToScreen and screenToWorldGround invert cleanly across all 4 compass rotations and pitches", () => {
    for (let step = 0; step < 4; step++) {
      const yaw = DEFAULT_YAW + step * (Math.PI / 2) + 0.22;
      for (const pitch of [15, 35, 65, 82]) {
        const cam = cameraFromTarget(55, 61, 1.4, yaw, pitch);
        const screen = worldToScreen(93, 27, 0, 1440, 900, cam);
        const back = screenToWorldGround(screen.x, screen.y, 1440, 900, cam);
        expect(Math.abs(back.x - 93)).toBeLessThan(1e-5);
        expect(Math.abs(back.z - 27)).toBeLessThan(1e-5);
      }
    }
  });

  test("worldToIso centers city midpoint at origin", () => {
    const mid = worldToIso(70, 52, 0);
    expect(mid.x).toBe(0);
    expect(mid.y).toBe(0);
  });

  test("cameraStore compass rotation, resetOrientation, and presets update unified camera state", () => {
    cameraStore.setState({
      yaw: DEFAULT_YAW,
      pitch: DEFAULT_PITCH,
      zoom: 1.0,
      targetX: WORLD_CENTER_X,
      targetZ: WORLD_CENTER_Z,
    });
    expect(cameraStore.getCompassLabel()).toBe("N");
    cameraStore.rotateCompass(1);
    expect(cameraStore.getCompassLabel()).toBe("E");

    cameraStore.applyPreset(3);
    expect(cameraStore.getState().pitch).toBe(14);
    expect(cameraStore.getState().zoom).toBeGreaterThan(2);

    // resetOrientation restores default yaw/pitch without resetting target
    cameraStore.setState({ yaw: 0.1, pitch: 72, targetX: 90, targetZ: 40 });
    cameraStore.resetOrientation();
    expect(Math.abs(cameraStore.getState().yaw - DEFAULT_YAW)).toBeLessThan(1e-6);
    expect(cameraStore.getState().pitch).toBe(DEFAULT_PITCH);
    expect(cameraStore.getState().targetX).toBe(90);
    expect(cameraStore.getState().targetZ).toBe(40);
  });

  test("cameraStore.panRelative aligns pan direction with camera yaw", () => {
    cameraStore.setState({
      targetX: WORLD_CENTER_X,
      targetZ: WORLD_CENTER_Z,
      yaw: DEFAULT_YAW + Math.PI / 2,
    });
    cameraStore.panRelative(10, 0);
    const afterYaw90Right = cameraStore.getState();

    cameraStore.setState({
      targetX: WORLD_CENTER_X,
      targetZ: WORLD_CENTER_Z,
      yaw: DEFAULT_YAW,
    });
    cameraStore.panRelative(0, 10);
    const afterDefaultFwd = cameraStore.getState();

    expect(Math.abs(afterYaw90Right.targetX - afterDefaultFwd.targetX)).toBeLessThan(1e-6);
    expect(Math.abs(afterYaw90Right.targetZ - afterDefaultFwd.targetZ)).toBeLessThan(1e-6);
  });

  test("computeMouseYaw and canvasCursorClass support Alt+drag yaw rotation", () => {
    const rightDragYaw = computeMouseYaw(DEFAULT_YAW, 160, 640);
    expect(Math.abs(rightDragYaw - (DEFAULT_YAW - Math.PI / 2))).toBeLessThan(1e-6);

    const leftDragYaw = computeMouseYaw(DEFAULT_YAW, -160, 640);
    expect(Math.abs(leftDragYaw - (DEFAULT_YAW + Math.PI / 2))).toBeLessThan(1e-6);

    // Respects minimum 320px viewport clamp
    expect(computeMouseYaw(1.0, 80, 100)).toBeCloseTo(1.0 - Math.PI / 2, 6);

    expect(canvasCursorClass("inspect", false, true)).toBe("cursor-ew-resize");
    expect(canvasCursorClass("sweeper", true, true)).toBe("cursor-ew-resize");
    expect(canvasCursorClass("inspect", true, false)).toBe("cursor-pointer");
  });

  test("computeHudMetrics and getHudShellStyle auto-scale compact and zoomed viewports", () => {
    const desktop = computeHudMetrics(1360, 840);
    expect(desktop.scale).toBe(1);
    expect(getHudShellStyle(desktop).transform).toBeUndefined();

    const zoomed = computeHudMetrics(640, 360);
    expect(zoomed.scale).toBeLessThan(1);
    expect(zoomed.vw).toBeGreaterThanOrEqual(1024);
    expect(zoomed.vh).toBeGreaterThanOrEqual(640);
    const style = getHudShellStyle(zoomed);
    expect(style.transform).toContain("scale(");
  });

  test("natural cityTheme variants, analytical datamap detection, and fault lines", () => {
    expect(isAnalyticalDataMap("living")).toBe(false);
    expect(isAnalyticalDataMap("hotspots")).toBe(true);
    expect(isAnalyticalDataMap("pollution")).toBe(true);

    const v0 = buildingVariantIndex("src/api/routes.ts", 3);
    expect(v0).toBe(buildingVariantIndex("src/api/routes.ts", 3));
    expect(v0).toBeGreaterThanOrEqual(0);
    expect(v0).toBeLessThan(3);

    const dummyFile = {
      file_path: "src/core/engine.py",
      building_archetype: "office_tower",
      language: "python",
      hotspot_score: 20,
      lint_issue_count: 0,
      format_drift: false,
      distinct_authors_90d: 2,
    } as FileMetric;

    const livingPal = buildingPalette(dummyFile, "living");
    const hotspotPal = buildingPalette(dummyFile, "hotspots");
    expect(livingPal.left).not.toBe(hotspotPal.left);
    expect(ZONE_PALETTES.greenbelt_parks.ground).toContain("#");

    const cochanges = [
      { snapshot_idx: 0, file_a: "a.py", file_b: "b.py", shared_commits: 4, coupling_ratio: 0.6 },
    ];
    expect(selectFaultLines(cochanges, null, null)).toEqual([]);
    expect(selectFaultLines(cochanges, "a.py", null).length).toBe(1);
  });

  test("islandLayout heightfield, harbor quay, and nature scatter placement", () => {
    // Urban plateau stays level at -0.04; distant ocean sits well below sea level
    expect(islandElevation(0, 0)).toBeCloseTo(-0.04, 6);
    expect(islandElevation(10, 52.8)).toBeCloseTo(-0.04, 6);
    expect(islandSignedDist(0, 0)).toBeLessThan(0);
    expect(islandSignedDist(0, 120)).toBeGreaterThan(0);
    expect(islandElevation(0, 120)).toBeLessThan(-2.0);

    const districts = [
      {
        district_path: "parks",
        zone_type: "greenbelt_parks",
        bounds_x: 20,
        bounds_z: 20,
        bounds_w: 24,
        bounds_d: 24,
      },
    ] as District[];
    const files = [
      {
        file_path: "park_file.py",
        layout_x: 28,
        layout_z: 28,
        layout_w: 4,
        layout_d: 4,
      },
    ] as FileMetric[];
    const scatter = computeNatureAndStreetPlacements(districts, files, [], {
      xLines: [20, 40, 60],
      zLines: [20, 40, 60],
    });
    expect(scatter.trees.length).toBeGreaterThan(30);
    expect(scatter.rocks.length).toBeGreaterThan(5);
    expect(scatter.sailboats.length).toBeGreaterThan(2);
    expect(scatter.streetlights.length).toBe(5);
  });

  test("2D static block renderer builds hit boxes for distinct archetypes and 3D slice/part cache", () => {
    const sample = { file_path: "src/app/tower.tsx", building_archetype: "office_tower" as const };
    const fullFile = {
      ...sample,
      snapshot_idx: 0,
      district_path: "src/app",
      language: "typescript",
      zone_type: "downtown_core",
      role_confidence: 0.9,
      role_signals: {},
      sloc: 180,
      symbol_count: 8,
      max_complexity: 9,
      type_or_doc_ratio: 0.5,
      lint_issue_count: 0,
      format_drift: false,
      lint_by_category: {},
      churn_90d: 3,
      bugfix_commits_90d: 0,
      distinct_authors_90d: 2,
      hotspot_score: 2,
      condition_flags: {},
      layout_x: 20,
      layout_z: 20,
      layout_w: 6,
      layout_d: 6,
    } as FileMetric;

    const noop = () => {};
    const mockCtx = {
      clearRect: noop,
      fillRect: noop,
      fillText: noop,
      measureText: () => ({ width: 32 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      fill: noop,
      stroke: noop,
      arc: noop,
      translate: noop,
      scale: noop,
      setLineDash: noop,
      quadraticCurveTo: noop,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      font: "",
      textAlign: "left",
    } as unknown as CanvasRenderingContext2D;

    const hits = renderStaticCityLayer({
      ctx: mockCtx,
      width: 1280,
      height: 720,
      camera: cameraFromTarget(WORLD_CENTER_X, WORLD_CENTER_Z, 1.0),
      districts: [],
      files: [
        fullFile,
        { ...fullFile, file_path: "db/silos.py", building_archetype: "twin_silos", layout_x: 32 },
        {
          ...fullFile,
          file_path: "tests/park.py",
          building_archetype: "park_stadium",
          layout_x: 44,
        },
      ],
      cochanges: [],
      deps: [],
      dataMap: "living",
      selectedFile: null,
      hoveredFile: null,
      blastRadius: null,
      addedFiles: new Set(),
      removedLots: [],
    });
    expect(hits.length).toBe(3);
    expect(hits[0].maxX).toBeGreaterThan(hits[0].minX);

    const wideOri = lotOrientation(fullFile, 6, 3);
    expect(wideOri.localW).toBeGreaterThanOrEqual(wideOri.localD);
    const tallOri = lotOrientation(fullFile, 3, 6);
    expect(tallOri.localW).toBeGreaterThanOrEqual(tallOri.localD);

    const slices = computeSliceHeights("office_tower", 12.0);
    expect(slices.baseH + slices.shaftH + slices.crownH).toBeCloseTo(12.0, 5);
    expect(slices.shaftH).toBeGreaterThan(slices.baseH);

    const geom = getPartGeometry("box");
    expect(geom.getAttribute("position").count).toBeGreaterThan(0);
    expect(getPartGeometry("box")).toBe(geom);
  });
});

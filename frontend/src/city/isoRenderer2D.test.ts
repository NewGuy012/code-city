import { describe, expect, test } from "bun:test";
import { computeHudMetrics, getHudShellStyle } from "../components/hudPopover";
import type { District, FileMetric } from "../types/city";
import {
  DEFAULT_PITCH,
  DEFAULT_ROLL,
  DEFAULT_YAW,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
} from "./cameraStore";
import {
  ZONE_PALETTES,
  buildingPalette,
  buildingVariantIndex,
  isAnalyticalDataMap,
  selectFaultLines,
} from "./cityTheme";
import { computeSliceHeights, getPartGeometry, lotOrientation } from "./geometries3D";
import {
  computeNatureAndStreetPlacements,
  islandElevation,
  islandSignedDist,
} from "./islandLayout";
import { cameraFromTarget, screenToWorldGround, worldToIso, worldToScreen } from "./isoRenderer2D";
import { ATLAS_TIERS, spriteAtlas } from "./spriteAtlas2D";

describe("isoRenderer2D projection", () => {
  test("worldToScreen and screenToWorldGround invert cleanly", () => {
    const cam = { panX: 25, panY: -15, zoom: 1.35 };
    const screen = worldToScreen(42, 68, 0, 1280, 720, cam);
    const back = screenToWorldGround(screen.x, screen.y, 1280, 720, cam);
    expect(Math.abs(back.x - 42)).toBeLessThan(1e-6);
    expect(Math.abs(back.z - 68)).toBeLessThan(1e-6);
  });

  test("worldToScreen and screenToWorldGround invert cleanly across all 4 compass rotations, pitches, and rolls", () => {
    for (let step = 0; step < 4; step++) {
      const yaw = DEFAULT_YAW + step * (Math.PI / 2) + 0.22;
      for (const pitch of [15, 35, 65, 82]) {
        for (const roll of [-90, -33, 0, 45, 135, 180]) {
          const cam = cameraFromTarget(55, 61, 1.4, yaw, pitch, roll);
          const screen = worldToScreen(93, 27, 0, 1440, 900, cam);
          const back = screenToWorldGround(screen.x, screen.y, 1440, 900, cam);
          expect(Math.abs(back.x - 93)).toBeLessThan(1e-5);
          expect(Math.abs(back.z - 27)).toBeLessThan(1e-5);
        }
      }
    }
  });

  test("worldToIso centers city midpoint at origin", () => {
    const mid = worldToIso(70, 52, 0);
    expect(mid.x).toBe(0);
    expect(mid.y).toBe(0);
  });

  test("cameraStore compass rotation, roll wrapping, resetOrientation, and presets update unified camera state", () => {
    cameraStore.setState({
      yaw: DEFAULT_YAW,
      pitch: DEFAULT_PITCH,
      roll: DEFAULT_ROLL,
      zoom: 1.0,
      targetX: WORLD_CENTER_X,
      targetZ: WORLD_CENTER_Z,
    });
    expect(cameraStore.getCompassLabel()).toBe("N");
    cameraStore.rotateCompass(1);
    expect(cameraStore.getCompassLabel()).toBe("E");

    // Roll endpoint preservation & continuous wrap-around
    cameraStore.setState({ roll: -180 });
    expect(cameraStore.getState().roll).toBe(-180);
    cameraStore.setState({ roll: 185 });
    expect(cameraStore.getState().roll).toBe(-175);
    cameraStore.setState({ roll: -185 });
    expect(cameraStore.getState().roll).toBe(175);

    // Preset resets roll back to level
    cameraStore.applyPreset(3);
    expect(cameraStore.getState().pitch).toBe(14);
    expect(cameraStore.getState().roll).toBe(0);
    expect(cameraStore.getState().zoom).toBeGreaterThan(2);

    // resetOrientation restores default yaw/pitch/roll without resetting target
    cameraStore.setState({ yaw: 0.1, pitch: 72, roll: 42, targetX: 90, targetZ: 40 });
    cameraStore.resetOrientation();
    expect(Math.abs(cameraStore.getState().yaw - DEFAULT_YAW)).toBeLessThan(1e-6);
    expect(cameraStore.getState().pitch).toBe(DEFAULT_PITCH);
    expect(cameraStore.getState().roll).toBe(0);
    expect(cameraStore.getState().targetX).toBe(90);
    expect(cameraStore.getState().targetZ).toBe(40);
  });

  test("cameraStore.panRelative aligns pan direction with camera roll", () => {
    cameraStore.setState({
      targetX: WORLD_CENTER_X,
      targetZ: WORLD_CENTER_Z,
      yaw: DEFAULT_YAW,
      roll: 90,
    });
    cameraStore.panRelative(10, 0);
    const afterRoll90 = cameraStore.getState();

    cameraStore.setState({
      targetX: WORLD_CENTER_X,
      targetZ: WORLD_CENTER_Z,
      yaw: DEFAULT_YAW,
      roll: 0,
    });
    cameraStore.panRelative(0, 10);
    const afterUnrolledFwd = cameraStore.getState();

    expect(Math.abs(afterRoll90.targetX - afterUnrolledFwd.targetX)).toBeLessThan(1e-6);
    expect(Math.abs(afterRoll90.targetZ - afterUnrolledFwd.targetZ)).toBeLessThan(1e-6);
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

  test("spriteAtlas 1x1 vs 1x2 rect selection and 3D architecture slice/part cache", () => {
    const sample = { file_path: "src/app/tower.tsx", building_archetype: "office_tower" as const };
    const squareSpec = spriteAtlas.getSpriteSpecForFile(sample, 4, 4, 42, 0);
    const wideSpec = spriteAtlas.getSpriteSpecForFile(sample, 8, 4, 42, 0);
    const t0Spec = spriteAtlas.getSpriteSpecForFile(sample, 4, 4, 18, 0);
    const t2Spec = spriteAtlas.getSpriteSpecForFile(sample, 4, 4, 68, 0);
    expect(t0Spec.tier).toBe(0);
    expect(t0Spec.sw).toBe(ATLAS_TIERS[0].cellW);
    expect(squareSpec.tier).toBe(1);
    expect(squareSpec.sw).toBe(ATLAS_TIERS[1].cellW);
    expect(squareSpec.sh).toBe(ATLAS_TIERS[1].cellH);
    expect(wideSpec.sw).toBe(ATLAS_TIERS[1].cellW);
    expect(wideSpec.sh).toBe(ATLAS_TIERS[1].cellH);
    expect(t2Spec.tier).toBe(2);
    expect(t2Spec.sw).toBe(ATLAS_TIERS[2].cellW);
    expect(t2Spec.sh).toBe(ATLAS_TIERS[2].cellH);
    // Wide lot uses slot 3 (col >= 12) while tall/wide flipped lots rotate by 90 deg
    expect(wideSpec.sx).toBeGreaterThanOrEqual(12 * ATLAS_TIERS[1].cellW);
    const tallSpec = spriteAtlas.getSpriteSpecForFile(sample, 4, 8, 42, 0);
    expect(Math.abs(tallSpec.rotOffset - wideSpec.rotOffset) % 2).toBe(1);

    const fullFile = { ...sample } as FileMetric;
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

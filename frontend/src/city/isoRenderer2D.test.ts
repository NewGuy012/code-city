import { describe, expect, test } from "bun:test";
import { computeHudMetrics, getHudShellStyle } from "../components/hudPopover";
import {
  DEFAULT_PITCH,
  DEFAULT_ROLL,
  DEFAULT_YAW,
  WORLD_CENTER_X,
  WORLD_CENTER_Z,
  cameraStore,
} from "./cameraStore";
import { cameraFromTarget, screenToWorldGround, worldToIso, worldToScreen } from "./isoRenderer2D";

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
});

import { describe, expect, test } from "bun:test";
import { cameraStore, DEFAULT_YAW } from "./cameraStore";
import {
  cameraFromTarget,
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

  test("worldToScreen and screenToWorldGround invert cleanly across all 4 compass rotations & pitches", () => {
    for (let step = 0; step < 4; step++) {
      const yaw = DEFAULT_YAW + step * (Math.PI / 2);
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

  test("cameraStore compass rotation and presets update unified camera state", () => {
    cameraStore.setState({ yaw: DEFAULT_YAW, pitch: 35, zoom: 1.0, targetX: 70, targetZ: 52 });
    expect(cameraStore.getCompassLabel()).toBe("N");
    cameraStore.rotateCompass(1);
    expect(cameraStore.getCompassLabel()).toBe("E");
    cameraStore.applyPreset(3);
    expect(cameraStore.getState().pitch).toBe(14);
    expect(cameraStore.getState().zoom).toBeGreaterThan(2);
  });
});

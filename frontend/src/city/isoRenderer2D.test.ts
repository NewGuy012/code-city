import { describe, expect, test } from "bun:test";
import { screenToWorldGround, worldToIso, worldToScreen } from "./isoRenderer2D";

describe("isoRenderer2D projection", () => {
  test("worldToScreen and screenToWorldGround invert cleanly", () => {
    const cam = { panX: 25, panY: -15, zoom: 1.35 };
    const screen = worldToScreen(42, 68, 0, 1280, 720, cam);
    const back = screenToWorldGround(screen.x, screen.y, 1280, 720, cam);
    expect(Math.abs(back.x - 42)).toBeLessThan(1e-6);
    expect(Math.abs(back.z - 68)).toBeLessThan(1e-6);
  });

  test("worldToIso centers city midpoint at origin", () => {
    const mid = worldToIso(70, 52, 0);
    expect(mid.x).toBe(0);
    expect(mid.y).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { BuildingArchetype, ZoneType } from "./types/city";

describe("CodeCity Studio types", () => {
  test("zone and archetype literals match DuckLake contracts", () => {
    const zone: ZoneType = "downtown_core";
    const archetype: BuildingArchetype = "city_hall";
    expect(zone).toBe("downtown_core");
    expect(archetype).toBe("city_hall");
  });
});

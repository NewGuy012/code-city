import type { District, FileMetric } from "../types/city";
import { WORLD_CENTER_X, WORLD_CENTER_Z } from "./cameraStore";
import { hashFilePath } from "./cityTheme";

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Distance outside the flat urban buildable plateau in centered world coordinates. */
export function plateauEdgeDistance(wx: number, wz: number): number {
  const dx = Math.abs(wx) - 71.2;
  const dz = Math.max(-53.2 - wz, wz - 53.2);
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  return Math.hypot(Math.max(0, dx), Math.max(0, dz));
}

/**
 * Signed coastline distance for the organic CodeCity island in centered world coords.
 * Negative = land; 0 = shoreline; Positive = open bay water.
 */
export function islandSignedDist(wx: number, wz: number): number {
  const quayBlend = smoothstep(42, 50, wz) * (1 - smoothstep(61, 69, Math.abs(wx)));
  const harborDist = wz - 53.4;

  const cx = 0;
  const cz = -6.0;
  const rx = 95.0;
  const rz = 72.0;
  const nx = (wx - cx) / rx;
  const nz = (wz - cz) / rz;
  const angle = Math.atan2(nz, nx);
  const wave =
    0.052 * Math.sin(angle * 5.0 + 0.55) +
    0.032 * Math.cos(angle * 9.0 - 1.1) +
    0.018 * Math.sin(wx * 0.13 + wz * 0.11);
  const radial = Math.hypot(nx, nz) - (1.0 + wave);
  const organicDist = radial * 76.0;

  if (quayBlend <= 0.001) return organicDist;
  return organicDist * (1 - quayBlend) + Math.max(organicDist, harborDist) * quayBlend;
}

/** Natural coastal island heightfield (flat -0.04 plateau inside the city grid). */
export function islandElevation(wx: number, wz: number): number {
  const pDist = plateauEdgeDistance(wx, wz);
  if (pDist <= 0) return -0.04;

  const sd = islandSignedDist(wx, wz);
  const isHarborQuay = wz > 52.4 && Math.abs(wx) < 64.5;

  if (sd >= 0) {
    const steep = isHarborQuay ? 1.15 : 0.24;
    return -3.2 * (1 - Math.exp(-sd * steep)) - 0.04;
  }

  if (isHarborQuay) {
    return -0.04;
  }

  const dIn = -sd;
  const beachBand = smoothstep(0.0, 4.2, dIn);
  const hillMask = smoothstep(0.0, 7.5, pDist) * smoothstep(2.5, 13.0, dIn);
  const ridge =
    (Math.sin(wx * 0.075 + 0.6) * Math.cos(wz * 0.085 - 0.4) * 0.5 + 0.5) * 4.6 +
    (Math.sin(wx * 0.16 - wz * 0.14) * 0.5 + 0.5) * 1.4;
  const northBoost = smoothstep(10, -68, wz) * 1.9;
  const shoreLift = beachBand * 0.42;
  return -0.04 + shoreLift + hillMask * (ridge + northBoost);
}

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotY: number;
  color: string;
  isPine: boolean;
}

export interface RockPlacement {
  x: number;
  y: number;
  z: number;
  scale: [number, number, number];
  rotY: number;
}

export interface SailboatPlacement {
  x: number;
  z: number;
  rotY: number;
  scale: number;
}

const TREE_GREENS = ["#4a8c42", "#589c4a", "#3c7a38", "#65a651", "#356e39"];

/** Deterministically scatter coastal forests, avenue/park trees, rocks, streetlights, and bay sailboats. */
export function computeNatureAndStreetPlacements(
  districts: District[],
  files: FileMetric[],
  plazas: Array<{ x: number; z: number; w: number; d: number; kind: string }>,
  streetLines?: { xLines: number[]; zLines: number[] },
): {
  trees: TreePlacement[];
  rocks: RockPlacement[];
  sailboats: SailboatPlacement[];
  streetlights: Array<{ x: number; z: number }>;
} {
  const trees: TreePlacement[] = [];
  const rocks: RockPlacement[] = [];
  const sailboats: SailboatPlacement[] = [];
  const streetlights: Array<{ x: number; z: number }> = [];

  const overlapsLot = (wx: number, wz: number, margin = 0.6): boolean => {
    const lx = wx + WORLD_CENTER_X;
    const lz = wz + WORLD_CENTER_Z;
    for (const f of files) {
      if (
        lx >= f.layout_x - margin &&
        lx <= f.layout_x + f.layout_w + margin &&
        lz >= f.layout_z - margin &&
        lz <= f.layout_z + f.layout_d + margin
      ) {
        return true;
      }
    }
    return false;
  };

  for (let gx = -94; gx <= 94; gx += 4.8) {
    for (let gz = -76; gz <= 60; gz += 4.8) {
      const h = hashFilePath(`t:${gx}:${gz}`);
      const jx = gx + ((h & 255) / 255 - 0.5) * 3.6;
      const jz = gz + (((h >> 8) & 255) / 255 - 0.5) * 3.6;
      if (plateauEdgeDistance(jx, jz) < 1.2) continue;
      const sd = islandSignedDist(jx, jz);
      if (sd > -1.8) continue;
      if (jz > 49 && Math.abs(jx) < 66) continue;
      const elev = islandElevation(jx, jz);
      if (elev < 0.14) continue;
      if ((h & 7) > 5) continue;

      trees.push({
        x: jx,
        y: elev - 0.05,
        z: jz,
        scale: 0.88 + ((h >> 16) % 55) * 0.015,
        rotY: ((h >> 12) % 360) * (Math.PI / 180),
        color: TREE_GREENS[h % TREE_GREENS.length],
        isPine: elev > 1.8 || (h & 3) === 0,
      });
    }
  }

  for (let i = 0; i < 38; i++) {
    const ang = (i / 38) * Math.PI * 2;
    const rx = Math.cos(ang) * 89;
    const rz = Math.sin(ang) * 67 - 6;
    if (rz > 44 && Math.abs(rx) < 67) continue;
    const sd = islandSignedDist(rx, rz);
    if (sd > 1.2 || sd < -6.5) continue;
    const elev = islandElevation(rx, rz);
    const h = hashFilePath(`rock:${i}`);
    rocks.push({
      x: rx,
      y: elev - 0.1,
      z: rz,
      scale: [0.8 + (h % 6) * 0.25, 0.55 + (h % 4) * 0.18, 0.8 + ((h >> 4) % 5) * 0.22],
      rotY: (h % 360) * (Math.PI / 180),
    });
  }

  for (const f of files) {
    if (f.building_archetype === "park_stadium") {
      for (const [ox, oz] of [
        [-0.4, -0.36],
        [0.4, 0.36],
      ]) {
        trees.push({
          x: f.layout_x + f.layout_w * (0.5 + ox) - WORLD_CENTER_X,
          y: 0.25,
          z: f.layout_z + f.layout_d * (0.5 + oz) - WORLD_CENTER_Z,
          scale: 0.85,
          rotY: ox * 2.1,
          color: "#4d9444",
          isPine: false,
        });
      }
    }
  }

  for (const d of districts) {
    if (d.zone_type === "greenbelt_parks") {
      for (let i = 0; i < 6; i++) {
        const h = hashFilePath(`${d.district_path}:gb:${i}`);
        const px =
          d.bounds_x + 1.2 + ((h % 100) / 100) * Math.max(1, d.bounds_w - 2.4) - WORLD_CENTER_X;
        const pz =
          d.bounds_z +
          1.2 +
          (((h >> 8) % 100) / 100) * Math.max(1, d.bounds_d - 2.4) -
          WORLD_CENTER_Z;
        if (!overlapsLot(px, pz, 0.5)) {
          trees.push({
            x: px,
            y: 0.14,
            z: pz,
            scale: 0.82,
            rotY: (h % 6) * 0.9,
            color: TREE_GREENS[h % TREE_GREENS.length],
            isPine: i % 3 === 0,
          });
        }
      }
    }
  }

  for (const p of plazas) {
    if (p.kind === "loading_bay") continue;
    trees.push({
      x: p.x + p.w * 0.5 - WORLD_CENTER_X,
      y: 0.2,
      z: p.z + p.d * 0.5 - WORLD_CENTER_Z,
      scale: 0.72,
      rotY: p.x * 0.5,
      color: "#579e4a",
      isPine: false,
    });
  }

  const xLines = streetLines?.xLines ?? [];
  const zLines = streetLines?.zLines ?? [];
  const nearRoad = (wx: number, wz: number): boolean => {
    const lx = wx + WORLD_CENTER_X;
    const lz = wz + WORLD_CENTER_Z;
    return (
      xLines.some((xl) => Math.abs(lx - xl) < 1.35) || zLines.some((zl) => Math.abs(lz - zl) < 1.35)
    );
  };

  for (const xl of xLines) {
    for (let lz = 6; lz <= 98; lz += 7.2) {
      if (zLines.some((zl) => Math.abs(lz - zl) < 2.8)) continue;
      const h = hashFilePath(`ax:${xl}:${lz}`);
      const wx = xl + (h % 2 === 0 ? 1.55 : -1.55) - WORLD_CENTER_X;
      const wz = lz - WORLD_CENTER_Z;
      if (!overlapsLot(wx, wz, 0.45) && !nearRoad(wx, wz)) {
        trees.push({
          x: wx,
          y: 0.12,
          z: wz,
          scale: 0.68 + (h % 4) * 0.06,
          rotY: (h % 6) * 0.9,
          color: TREE_GREENS[h % TREE_GREENS.length],
          isPine: false,
        });
      }
    }
  }
  for (const zl of zLines) {
    for (let lx = 6; lx <= 134; lx += 7.8) {
      if (xLines.some((xl) => Math.abs(lx - xl) < 2.8)) continue;
      const h = hashFilePath(`az:${lx}:${zl}`);
      const wx = lx - WORLD_CENTER_X;
      const wz = zl + (h % 2 === 0 ? 1.55 : -1.55) - WORLD_CENTER_Z;
      if (!overlapsLot(wx, wz, 0.45) && !nearRoad(wx, wz)) {
        trees.push({
          x: wx,
          y: 0.12,
          z: wz,
          scale: 0.68 + (h % 4) * 0.06,
          rotY: (h % 6) * 0.9,
          color: TREE_GREENS[h % TREE_GREENS.length],
          isPine: false,
        });
      }
    }
  }

  for (const d of districts) {
    for (let i = 0; i < 4; i++) {
      const h = hashFilePath(`dt:${d.district_path}:${i}`);
      const px =
        d.bounds_x + 0.8 + ((h % 100) / 100) * Math.max(1, d.bounds_w - 1.6) - WORLD_CENTER_X;
      const pz =
        d.bounds_z +
        0.8 +
        (((h >> 8) % 100) / 100) * Math.max(1, d.bounds_d - 1.6) -
        WORLD_CENTER_Z;
      if (!overlapsLot(px, pz, 0.55) && !nearRoad(px, pz)) {
        trees.push({
          x: px,
          y: 0.14,
          z: pz,
          scale: 0.72 + (h % 3) * 0.07,
          rotY: (h % 6) * 1.1,
          color: TREE_GREENS[h % TREE_GREENS.length],
          isPine: (h & 3) === 0,
        });
      }
    }
  }

  for (let xi = 0; xi < xLines.length; xi++) {
    for (let zi = 0; zi < zLines.length; zi++) {
      if ((xi + zi) % 2 !== 0) continue;
      streetlights.push({
        x: xLines[xi] + 1.35 - WORLD_CENTER_X,
        z: zLines[zi] + 1.35 - WORLD_CENTER_Z,
      });
    }
  }

  const boatCoords: Array<[number, number, number]> = [
    [-108, 72, 0.5],
    [-68, 86, 1.2],
    [42, 88, -0.7],
    [106, 68, -1.9],
    [122, -18, 2.3],
    [-120, -28, 0.8],
  ];
  for (let i = 0; i < boatCoords.length; i++) {
    const [bx, bz, rot] = boatCoords[i];
    sailboats.push({ x: bx, z: bz, rotY: rot, scale: 0.95 + (i % 3) * 0.18 });
  }

  return { trees, rocks, sailboats, streetlights };
}

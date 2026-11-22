import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { BuildingArchetype, DataMapMode, FileMetric } from "../types/city";
import { WORLD_CENTER_X, WORLD_CENTER_Z } from "./cameraStore";
import {
  buildingPalette,
  buildingVariantIndex,
  computeBuildingHeight,
  hashFilePath,
} from "./cityTheme";
import type { BuildingSliceKind, ShaderFacadeMode } from "./shaders3D";

const ARCHETYPE_HEIGHT_PROFILE: Record<BuildingArchetype, { mult: number; cap: number }> = {
  office_tower: { mult: 0.38, cap: 29 },
  city_hall: { mult: 0.36, cap: 27 },
  watchtower: { mult: 0.32, cap: 22 },
  twin_silos: { mult: 0.28, cap: 18 },
  glass_pavilion: { mult: 0.24, cap: 13.5 },
  archive_vault: { mult: 0.23, cap: 12.5 },
  grand_terminal: { mult: 0.21, cap: 11.5 },
  factory: { mult: 0.19, cap: 9.5 },
  civic_kiosk: { mult: 0.16, cap: 6.8 },
  park_stadium: { mult: 0.08, cap: 1.65 },
};

export function buildingHeight3D(file: FileMetric): number {
  if (file.building_archetype === "park_stadium") return 1.65;
  const prof = ARCHETYPE_HEIGHT_PROFILE[file.building_archetype] ?? { mult: 0.3, cap: 24 };
  return Math.max(2.6, Math.min(prof.cap, computeBuildingHeight(file) * prof.mult));
}

export function buildingFootprint3D(file: FileMetric): {
  bw: number;
  bd: number;
  h: number;
  cx: number;
  cz: number;
} {
  const pad = Math.min(0.45, Math.min(file.layout_w, file.layout_d) * 0.14);
  return {
    bw: Math.max(0.8, file.layout_w - pad * 2),
    bd: Math.max(0.8, file.layout_d - pad * 2),
    h: buildingHeight3D(file),
    cx: file.layout_x + file.layout_w * 0.5 - WORLD_CENTER_X,
    cz: file.layout_z + file.layout_d * 0.5 - WORLD_CENTER_Z,
  };
}

/** Deterministic street-aligned lot rotation; rotates 90 deg when depth > width so localW >= localD. */
export function lotOrientation(
  file: FileMetric,
  bw: number,
  bd: number,
): { rotY: number; localW: number; localD: number } {
  const h = hashFilePath(file.file_path);
  let step: number;
  if (bw > bd * 1.15) {
    step = (h & 1) === 0 ? 0 : 2;
  } else if (bd > bw * 1.15) {
    step = (h & 1) === 0 ? 1 : 3;
  } else {
    step = h & 3;
  }
  const swapped = step % 2 === 1;
  return {
    rotY: step * Math.PI * 0.5,
    localW: swapped ? bd : bw,
    localD: swapped ? bw : bd,
  };
}

export interface SliceHeights {
  baseH: number;
  shaftH: number;
  crownH: number;
}

export function computeSliceHeights(arch: BuildingArchetype, totalH: number): SliceHeights {
  if (arch === "park_stadium") {
    return { baseH: 0.28, shaftH: Math.max(0.55, totalH - 0.65), crownH: 0.37 };
  }
  const baseH = Math.min(totalH * 0.26, Math.max(0.65, Math.min(1.9, totalH * 0.16)));
  const crownH = Math.min(totalH * 0.24, Math.max(0.55, Math.min(2.1, totalH * 0.14)));
  const shaftH = Math.max(0.7, totalH - baseH - crownH);
  return { baseH, shaftH, crownH };
}

export function buildingColor3D(
  file: FileMetric,
  dataMap: DataMapMode,
  selectedFile: string | null,
  impactedHop: Map<string, number>,
): string {
  if (selectedFile && impactedHop.size > 0) {
    if (file.file_path === selectedFile) return "#fef08a";
    const hop = impactedHop.get(file.file_path);
    if (hop === 1) return "#f59e0b";
    if (hop !== undefined && hop >= 2) return "#38bdf8";
    return "#64748b";
  }
  if (selectedFile && file.file_path === selectedFile) return "#fef08a";
  return buildingPalette(file, dataMap).left;
}

export interface BuildingPartSpec {
  id: string;
  geomKey: string;
  slice: BuildingSliceKind;
  role: "main" | "podium" | "trim" | "roof" | "beacon" | "turf" | "foliage";
  shaderMode: ShaderFacadeMode;
  offset: [number, number, number];
  scale: [number, number, number];
  squareAspect?: boolean;
  tintHex?: string;
}

/* -------------------------------------------------------------------------- */
/* Procedural Architectural Geometry Builders (normalized to x,z in [-.5,.5], y in [0,1]) */
/* -------------------------------------------------------------------------- */

function prepPiece(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geom.index ? geom.toNonIndexed() : geom;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const count = g.attributes.position.count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv") {
      g.deleteAttribute(key);
    }
  }
  return g;
}

function composePieces(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepped = pieces.map(prepPiece);
  const merged = mergeGeometries(prepped, false);
  for (const p of prepped) p.dispose();
  if (!merged) {
    const fallback = new THREE.BoxGeometry(1, 1, 1);
    fallback.translate(0, 0.5, 0);
    return fallback;
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function mkBox(w: number, h: number, d: number, cx = 0, y0 = 0, cz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, y0 + h * 0.5, cz);
  return g;
}

function mkChamferBox(
  w: number,
  h: number,
  d: number,
  chamfer = 0.08,
  cx = 0,
  y0 = 0,
  cz = 0,
): THREE.BufferGeometry {
  const hw = w * 0.5;
  const hd = d * 0.5;
  const c = Math.min(chamfer, hw * 0.45, hd * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + c, -hd);
  shape.lineTo(hw - c, -hd);
  shape.lineTo(hw, -hd + c);
  shape.lineTo(hw, hd - c);
  shape.lineTo(hw - c, hd);
  shape.lineTo(-hw + c, hd);
  shape.lineTo(-hw, hd - c);
  shape.lineTo(-hw, -hd + c);
  shape.closePath();

  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, steps: 1 });
  g.rotateX(-Math.PI * 0.5);
  g.translate(cx, y0, cz);
  return g;
}

function mkCyl(
  rx: number,
  rz: number,
  h: number,
  segs = 16,
  cx = 0,
  y0 = 0,
  cz = 0,
  rTopScale = 1.0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTopScale, 1, h, segs);
  g.scale(rx, 1, rz);
  g.translate(cx, y0 + h * 0.5, cz);
  return g;
}

function mkDome(
  rx: number,
  h: number,
  rz: number,
  segs = 16,
  cx = 0,
  y0 = 0,
  cz = 0,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segs, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
  g.scale(rx, h, rz);
  g.translate(cx, y0, cz);
  return g;
}

function mkHipRoof(w: number, h: number, d: number, cx = 0, y0 = 0, cz = 0): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, h, 4);
  g.rotateY(Math.PI * 0.25);
  g.scale(w, 1, d);
  g.translate(cx, y0 + h * 0.5, cz);
  return g;
}

function mkGableRoof(
  w: number,
  h: number,
  d: number,
  cx = 0,
  y0 = 0,
  cz = 0,
  ridgeAlongX = true,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const span = ridgeAlongX ? d : w;
  const len = ridgeAlongX ? w : d;
  shape.moveTo(-span * 0.5, 0);
  shape.lineTo(span * 0.5, 0);
  shape.lineTo(0, h);
  shape.closePath();

  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len * 0.5);
  if (ridgeAlongX) {
    g.rotateY(Math.PI * 0.5);
  }
  g.translate(cx, y0, cz);
  return g;
}

function mkSawtoothBay(
  w: number,
  h: number,
  d: number,
  cx = 0,
  y0 = 0,
  cz = 0,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w * 0.5, 0);
  shape.lineTo(w * 0.5, 0);
  shape.lineTo(-w * 0.2, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  g.translate(cx, y0, cz - d * 0.5);
  return g;
}

function mkArchVault(
  w: number,
  h: number,
  d: number,
  cx = 0,
  y0 = 0,
  cz = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5, w, 16, 1, false, 0, Math.PI);
  g.rotateZ(Math.PI * 0.5);
  g.scale(1, h * 2, d);
  g.translate(cx, y0, cz);
  return g;
}

function addParapetWalls(
  pieces: THREE.BufferGeometry[],
  w: number,
  d: number,
  y0: number,
  h = 0.16,
  t = 0.055,
): void {
  pieces.push(
    mkBox(w, h, t, 0, y0, -d * 0.5 + t * 0.5),
    mkBox(w, h, t, 0, y0, d * 0.5 - t * 0.5),
    mkBox(t, h, d - t * 2, -w * 0.5 + t * 0.5, y0, 0),
    mkBox(t, h, d - t * 2, w * 0.5 - t * 0.5, y0, 0),
  );
}

const PART_GEOM_BUILDERS: Record<string, () => THREE.BufferGeometry> = {
  // Shared Bases / Plinths
  podium_steps: () =>
    composePieces([
      mkBox(1.0, 0.35, 1.0, 0, 0, 0),
      mkBox(0.92, 0.65, 0.92, 0, 0.35, 0),
      mkBox(0.36, 0.25, 0.12, 0, 0.72, 0.49),
    ]),
  podium_colonnade: () => {
    const pieces = [
      mkBox(1.0, 0.2, 1.0, 0, 0, 0),
      mkBox(0.84, 0.72, 0.84, 0, 0.2, 0),
      mkBox(0.96, 0.12, 0.96, 0, 0.88, 0),
    ];
    for (const px of [-0.42, -0.14, 0.14, 0.42]) {
      pieces.push(mkCyl(0.032, 0.032, 0.68, 8, px, 0.2, 0.43));
      pieces.push(mkCyl(0.032, 0.032, 0.68, 8, px, 0.2, -0.43));
    }
    return composePieces(pieces);
  },
  podium_lobby_canopy: () =>
    composePieces([
      mkBox(0.98, 0.22, 0.98, 0, 0, 0),
      mkBox(0.86, 0.78, 0.86, 0, 0.22, 0),
      mkBox(0.46, 0.08, 0.18, 0, 0.58, 0.49),
    ]),
  podium_dock: () =>
    composePieces([
      mkBox(0.98, 0.55, 0.96, 0, 0, 0),
      mkBox(0.9, 0.45, 0.88, 0, 0.55, 0),
      mkBox(0.55, 0.14, 0.14, 0, 0.78, 0.48),
    ]),

  // Office Tower Shafts (3 distinct skyscraper silhouettes)
  tower_chamfer: () => {
    const pieces = [mkChamferBox(0.86, 1.0, 0.86, 0.11, 0, 0, 0)];
    for (const x of [-0.24, 0.24]) {
      pieces.push(mkBox(0.04, 0.992, 0.88, x, 0, 0));
    }
    for (const z of [-0.24, 0.24]) {
      pieces.push(mkBox(0.88, 0.992, 0.04, 0, 0, z));
    }
    return composePieces(pieces);
  },
  tower_setback: () =>
    composePieces([
      mkBox(0.9, 0.42, 0.88, 0, 0, 0),
      mkBox(0.74, 0.34, 0.72, 0, 0.42, 0),
      mkBox(0.56, 0.24, 0.54, 0, 0.76, 0),
      mkBox(0.54, 0.97, 0.05, 0, 0, 0.36),
    ]),
  tower_twin_slab: () =>
    composePieces([
      mkBox(0.88, 0.62, 0.84, 0, 0, 0),
      mkBox(0.64, 0.38, 0.54, -0.1, 0.62, -0.1),
      mkBox(0.28, 0.84, 0.28, 0.25, 0.16, 0.22),
    ]),

  // Office Tower Crowns
  crown_penthouse_hvac: () => {
    const pieces = [mkBox(0.76, 0.14, 0.76, 0, 0, 0)];
    addParapetWalls(pieces, 0.76, 0.76, 0.14, 0.16, 0.05);
    pieces.push(
      mkBox(0.38, 0.42, 0.34, -0.06, 0.14, -0.06),
      mkBox(0.14, 0.22, 0.14, 0.2, 0.14, 0.18),
      mkBox(0.14, 0.22, 0.14, -0.2, 0.14, 0.18),
    );
    return composePieces(pieces);
  },
  crown_deco_spire: () =>
    composePieces([
      mkBox(0.56, 0.22, 0.54, 0, 0, 0),
      mkBox(0.4, 0.26, 0.38, 0, 0.22, 0),
      mkHipRoof(0.32, 0.32, 0.3, 0, 0.48, 0),
      mkCyl(0.02, 0.02, 0.38, 8, 0, 0.72, 0, 0.3),
    ]),
  crown_helipad: () => {
    const pieces = [mkBox(0.64, 0.26, 0.56, -0.06, 0, -0.06)];
    addParapetWalls(pieces, 0.64, 0.56, 0.26, 0.14, 0.05);
    pieces.push(mkCyl(0.22, 0.22, 0.06, 16, 0, 0.3, 0), mkBox(0.22, 0.12, 0.16, -0.14, 0.28, -0.1));
    return composePieces(pieces);
  },

  // City Hall (3 variants)
  hall_cruciform: () => {
    const pieces = [mkBox(0.9, 0.96, 0.74, 0, 0, 0), mkBox(0.52, 1.0, 0.92, 0, 0, 0)];
    for (const px of [-0.18, -0.06, 0.06, 0.18]) {
      pieces.push(mkCyl(0.028, 0.028, 0.92, 8, px, 0, 0.45));
    }
    return composePieces(pieces);
  },
  hall_beaux_arts: () =>
    composePieces([
      mkBox(0.94, 0.92, 0.72, 0, 0, -0.04),
      mkBox(0.28, 1.0, 0.88, -0.33, 0, 0.02),
      mkBox(0.28, 1.0, 0.88, 0.33, 0, 0.02),
      mkBox(0.46, 0.96, 0.14, 0, 0, 0.36),
    ]),
  hall_rotunda_base: () =>
    composePieces([mkBox(0.92, 0.68, 0.84, 0, 0, 0), mkCyl(0.36, 0.36, 1.0, 16, 0, 0, 0)]),
  dome_copper: () => {
    const pieces = [
      mkCyl(0.44, 0.44, 0.32, 16, 0, 0, 0),
      mkDome(0.42, 0.46, 0.42, 16, 0, 0.32, 0),
      mkCyl(0.11, 0.11, 0.18, 10, 0, 0.76, 0),
    ];
    return composePieces(pieces);
  },
  crown_mansard_clock: () =>
    composePieces([
      mkHipRoof(0.94, 0.34, 0.88, 0, 0, 0),
      mkBox(0.28, 0.54, 0.28, 0, 0.18, 0),
      mkHipRoof(0.3, 0.32, 0.3, 0, 0.72, 0),
    ]),

  // Grand Terminal
  terminal_shed: () => {
    const pieces = [mkBox(0.94, 0.66, 0.82, 0, 0, 0), mkArchVault(0.9, 0.34, 0.72, 0, 0.66, 0)];
    for (const rx of [-0.36, -0.12, 0.12, 0.36]) {
      pieces.push(mkBox(0.045, 0.7, 0.85, rx, 0, 0));
    }
    return composePieces(pieces);
  },
  terminal_modern: () =>
    composePieces([
      mkBox(0.96, 0.72, 0.76, 0, 0, 0),
      mkBox(0.98, 0.14, 0.88, 0, 0.72, 0),
      mkArchVault(0.68, 0.22, 0.54, -0.08, 0.84, 0),
    ]),
  terminal_clocktower: () =>
    composePieces([
      mkBox(1.0, 0.86, 1.0, 0, 0, 0),
      mkBox(1.12, 0.05, 1.12, 0, 0.84, 0),
      mkBox(0.72, 0.08, 0.72, 0, 0.89, 0),
      mkHipRoof(0.76, 0.08, 0.76, 0, 0.97, 0),
    ]),

  // Twin Silos
  silos_twin: () =>
    composePieces([
      mkCyl(0.23, 0.23, 1.0, 16, -0.24, 0, 0),
      mkCyl(0.23, 0.23, 1.0, 16, 0.24, 0, 0),
      mkBox(0.06, 0.92, 0.08, -0.02, 0, 0.2),
      mkBox(0.06, 0.92, 0.08, 0.02, 0, -0.2),
    ]),
  silos_quad: () =>
    composePieces([
      mkCyl(0.19, 0.19, 1.0, 14, -0.22, 0, -0.21),
      mkCyl(0.19, 0.19, 1.0, 14, 0.22, 0, -0.21),
      mkCyl(0.19, 0.19, 0.92, 14, -0.22, 0, 0.21),
      mkCyl(0.19, 0.19, 0.92, 14, 0.22, 0, 0.21),
    ]),
  silos_caps_catwalk: () =>
    composePieces([
      mkCyl(0.24, 0.24, 0.42, 16, -0.24, 0, 0, 0.08),
      mkCyl(0.24, 0.24, 0.42, 16, 0.24, 0, 0, 0.08),
      mkBox(0.56, 0.16, 0.16, 0, 0.28, 0),
      mkBox(0.14, 0.34, 0.14, 0, 0.44, 0),
    ]),
  silos_quad_caps: () =>
    composePieces([
      mkDome(0.2, 0.34, 0.2, 14, -0.22, 0, -0.21),
      mkDome(0.2, 0.34, 0.2, 14, 0.22, 0, -0.21),
      mkDome(0.2, 0.34, 0.2, 14, -0.22, 0, 0.21),
      mkDome(0.2, 0.34, 0.2, 14, 0.22, 0, 0.21),
      mkBox(0.56, 0.14, 0.56, 0, 0.18, 0),
    ]),

  // Factory
  factory_sawtooth: () => {
    const pieces = [mkBox(0.92, 0.68, 0.86, -0.02, 0, 0)];
    for (const sx of [-0.31, -0.02, 0.27]) {
      pieces.push(mkSawtoothBay(0.28, 0.32, 0.84, sx, 0.68, 0));
    }
    for (const px of [-0.46, 0, 0.44]) {
      pieces.push(mkBox(0.05, 0.68, 0.9, px, 0, 0));
    }
    return composePieces(pieces);
  },
  factory_clerestory: () =>
    composePieces([
      mkBox(0.94, 0.68, 0.88, 0, 0, 0),
      mkBox(0.76, 0.26, 0.38, -0.04, 0.68, 0),
      mkGableRoof(0.78, 0.14, 0.42, -0.04, 0.94, 0, true),
    ]),
  factory_stacks: () =>
    composePieces([
      mkTaperStack(0.075, 0.105, 1.0, 0.34, 0, -0.22),
      mkTaperStack(0.075, 0.105, 0.92, 0.34, 0, 0.22),
      mkBox(0.24, 0.18, 0.22, -0.18, 0, 0),
    ]),
  factory_single_stack: () =>
    composePieces([
      mkTaperStack(0.09, 0.13, 1.0, 0.32, 0, -0.22),
      mkBox(0.26, 0.2, 0.26, -0.18, 0, 0.14),
      mkCyl(0.09, 0.09, 0.18, 12, -0.18, 0.2, -0.18),
    ]),

  // Archive Vault
  vault_pediment_hall: () => {
    const pieces = [mkBox(0.86, 1.0, 0.84, 0, 0, 0)];
    for (const px of [-0.39, 0, 0.39]) {
      pieces.push(mkBox(0.065, 0.985, 0.88, px, 0, 0));
    }
    return composePieces(pieces);
  },
  vault_pilasters: () => {
    const pieces = [mkBox(0.88, 1.0, 0.86, 0, 0, 0)];
    for (const px of [-0.41, 0, 0.41]) {
      pieces.push(mkBox(0.055, 0.985, 0.9, px, 0, 0));
    }
    for (const pz of [-0.4, 0.4]) {
      pieces.push(mkBox(0.9, 0.985, 0.055, 0, 0, pz));
    }
    return composePieces(pieces);
  },
  roof_gable_classic: () =>
    composePieces([
      mkBox(0.9, 0.16, 0.88, 0, 0, 0),
      mkGableRoof(0.94, 0.84, 0.92, 0, 0.16, 0, true),
    ]),
  roof_hipped_slate: () =>
    composePieces([
      mkBox(0.92, 0.18, 0.9, 0, 0, 0),
      mkHipRoof(0.94, 0.72, 0.92, 0, 0.18, 0),
      mkBox(0.32, 0.2, 0.24, 0, 0.74, 0),
    ]),

  // Glass Pavilion
  pavilion_cantilever: () =>
    composePieces([
      mkBox(0.94, 0.44, 0.9, 0, 0, 0),
      mkBox(1.0, 0.08, 0.96, 0, 0.44, 0),
      mkBox(0.9, 0.48, 0.86, 0, 0.52, 0),
    ]),
  pavilion_terraced: () =>
    composePieces([mkBox(0.96, 0.48, 0.92, 0, 0, 0), mkBox(0.76, 0.52, 0.74, -0.06, 0.48, -0.04)]),
  pavilion_chamfer: () =>
    composePieces([
      mkChamferBox(0.94, 0.92, 0.9, 0.12, 0, 0, 0),
      mkChamferBox(1.0, 0.08, 0.96, 0.12, 0, 0.92, 0),
    ]),
  crown_garden_pergola: () => {
    const pieces = [mkBox(0.72, 0.22, 0.68, 0, 0, 0)];
    for (const gx of [-0.24, 0, 0.24]) {
      pieces.push(mkBox(0.05, 0.45, 0.5, gx, 0.22, 0));
    }
    return composePieces(pieces);
  },
  crown_skylight_atrium: () => {
    const pieces = [mkBox(0.78, 0.14, 0.74, 0, 0, 0)];
    addParapetWalls(pieces, 0.78, 0.74, 0.14, 0.14, 0.05);
    pieces.push(mkGableRoof(0.56, 0.48, 0.48, 0, 0.14, 0, true));
    return composePieces(pieces);
  },
  crown_terrace_louver: () => {
    const pieces = [mkBox(0.86, 0.14, 0.84, 0, 0, 0)];
    addParapetWalls(pieces, 0.86, 0.84, 0.14, 0.12, 0.045);
    pieces.push(
      mkBox(0.36, 0.28, 0.34, -0.14, 0.14, -0.1),
      mkBox(0.28, 0.14, 0.28, 0.18, 0.14, 0.14),
    );
    return composePieces(pieces);
  },

  // Watchtower
  watchtower_core: () =>
    composePieces([
      mkChamferBox(0.72, 0.85, 0.72, 0.14, 0, 0, 0),
      mkCyl(0.36, 0.36, 1.0, 8, 0, 0, 0, 0.78),
    ]),
  watchtower_cab: () =>
    composePieces([
      mkCyl(0.42, 0.42, 0.55, 8, 0, 0, 0, 1.18),
      mkHipRoof(0.86, 0.28, 0.86, 0, 0.55, 0),
      mkCyl(0.04, 0.04, 0.36, 8, 0, 0.82, 0, 0.4),
    ]),

  // Civic Kiosk
  kiosk_body: () =>
    composePieces([mkBox(0.82, 0.92, 0.78, 0, 0, 0), mkBox(0.88, 0.12, 0.24, 0, 0.42, 0.38)]),
  roof_hipped_tile: () =>
    composePieces([mkHipRoof(0.98, 0.78, 0.94, 0, 0, 0), mkBox(0.14, 0.36, 0.14, 0.2, 0.4, -0.14)]),
  roof_gable_townhouse: () =>
    composePieces([
      mkGableRoof(0.96, 0.82, 0.92, 0, 0, 0, true),
      mkBox(0.14, 0.38, 0.14, -0.22, 0.38, -0.16),
    ]),

  // Park Stadium
  stadium_turf: () => mkBox(0.96, 1.0, 0.96, 0, 0, 0),
  stadium_stands: () => {
    const pieces = [];
    for (const [zSign, tiers] of [
      [-1, 3],
      [1, 2],
    ] as const) {
      for (let t = 0; t < tiers; t++) {
        pieces.push(mkBox(0.84, 0.28, 0.09, 0, t * 0.25, zSign * (0.31 + t * 0.065)));
      }
    }
    // Cantilevered north grandstand roof canopy
    pieces.push(mkBox(0.86, 0.14, 0.24, 0, 0.86, -0.37));
    return composePieces(pieces);
  },
  stadium_floodlight_poles: () => {
    const pieces = [];
    for (const sx of [-0.44, 0.44]) {
      for (const sz of [-0.44, 0.44]) {
        pieces.push(mkCyl(0.022, 0.022, 0.92, 6, sx, 0, sz));
      }
    }
    return composePieces(pieces);
  },
  stadium_floodlight_lamps: () => {
    const pieces = [];
    for (const sx of [-0.44, 0.44]) {
      for (const sz of [-0.44, 0.44]) {
        pieces.push(mkBox(0.09, 0.09, 0.09, sx, 0.9, sz));
      }
    }
    return composePieces(pieces);
  },
  stadium_amphitheater: () => {
    const pieces = [];
    for (let t = 0; t < 3; t++) {
      pieces.push(mkBox(0.76 - t * 0.08, 0.24, 0.12, 0, t * 0.22, -0.3 + t * 0.07));
    }
    pieces.push(mkBox(0.28, 0.65, 0.24, 0.26, 0, 0.24));
    pieces.push(mkHipRoof(0.34, 0.3, 0.3, 0.26, 0.65, 0.24));
    return composePieces(pieces);
  },
  stadium_corner_stand: () => {
    const pieces = [];
    for (let t = 0; t < 3; t++) {
      pieces.push(mkBox(0.84, 0.26, 0.09, 0, t * 0.24, -0.3 + t * 0.065));
      pieces.push(mkBox(0.09, 0.26, 0.66, -0.3 + t * 0.065, t * 0.24, 0.04));
    }
    pieces.push(mkBox(0.86, 0.12, 0.24, 0, 0.84, -0.36));
    return composePieces(pieces);
  },
  beacon_spire: () => mkCyl(0.05, 0.14, 1.0, 10, 0, 0, 0, 0.25),
  beacon_orb: () => {
    const g = new THREE.SphereGeometry(0.5, 10, 8);
    g.translate(0, 0.5, 0);
    return g;
  },
};

function mkTaperStack(
  rTop: number,
  rBot: number,
  h: number,
  cx: number,
  y0: number,
  cz: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, 10);
  g.translate(cx, y0 + h * 0.5, cz);
  return g;
}

export const ARCHETYPE_VARIANT_KITS: Record<BuildingArchetype, BuildingPartSpec[][]> = {
  office_tower: [
    // Variant 0: Chamfered glass curtain-wall skyscraper + HVAC parapet
    [
      {
        id: "base",
        geomKey: "podium_lobby_canopy",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.96],
        tintHex: "#8d96a0",
      },
      {
        id: "shaft",
        geomKey: "tower_chamfer",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.9, 1, 0.9],
      },
      {
        id: "crown",
        geomKey: "crown_penthouse_hvac",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.88, 1, 0.88],
        tintHex: "#9aa4b0",
      },
      {
        id: "beacon",
        geomKey: "beacon_spire",
        slice: "crown",
        role: "beacon",
        shaderMode: "solid",
        offset: [0, 0.4, 0],
        scale: [0.12, 0.75, 0.12],
        squareAspect: true,
        tintHex: "#fde68a",
      },
    ],
    // Variant 1: Art Deco stepped limestone & glass tower + spire
    [
      {
        id: "base",
        geomKey: "podium_colonnade",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#c2b8a8",
      },
      {
        id: "shaft",
        geomKey: "tower_setback",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "crown_deco_spire",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.85, 1, 0.85],
        tintHex: "#cbd5e1",
      },
    ],
    // Variant 2: Twin-slab corporate high-rise + rooftop helipad
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#7c8692",
      },
      {
        id: "shaft",
        geomKey: "tower_twin_slab",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "crown_helipad",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.9, 1, 0.9],
        tintHex: "#94a3b8",
      },
    ],
  ],
  city_hall: [
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [1.0, 1, 1.0],
        tintHex: "#d5cec2",
      },
      {
        id: "shaft",
        geomKey: "hall_cruciform",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.9, 1, 0.9],
      },
      {
        id: "dome",
        geomKey: "dome_copper",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.76, 1.15, 0.76],
        squareAspect: true,
        tintHex: "#5f9d86",
      },
      {
        id: "beacon",
        geomKey: "beacon_spire",
        slice: "crown",
        role: "beacon",
        shaderMode: "solid",
        offset: [0, 0.85, 0],
        scale: [0.14, 0.55, 0.14],
        squareAspect: true,
        tintHex: "#fde047",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_colonnade",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [1.0, 1, 1.0],
        tintHex: "#cfc7ba",
      },
      {
        id: "shaft",
        geomKey: "hall_beaux_arts",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "crown_mansard_clock",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.9, 1.1, 0.9],
        tintHex: "#5a7280",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [1.0, 1, 1.0],
        tintHex: "#d8d1c5",
      },
      {
        id: "shaft",
        geomKey: "hall_rotunda_base",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "dome",
        geomKey: "dome_copper",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.72, 1.1, 0.72],
        squareAspect: true,
        tintHex: "#62a38a",
      },
    ],
  ],
  grand_terminal: [
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.92],
        tintHex: "#9aa2ab",
      },
      {
        id: "shaft",
        geomKey: "terminal_shed",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.9],
      },
      {
        id: "clocktower",
        geomKey: "terminal_clocktower",
        slice: "full",
        role: "trim",
        shaderMode: "stone",
        offset: [0.34, 0, -0.26],
        scale: [0.26, 1.16, 0.26],
        squareAspect: true,
        tintHex: "#c9bfa9",
      },
      {
        id: "beacon",
        geomKey: "beacon_orb",
        slice: "full",
        role: "beacon",
        shaderMode: "solid",
        offset: [0.34, 1.05, -0.26],
        scale: [0.14, 0.08, 0.14],
        squareAspect: true,
        tintHex: "#fef08a",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_lobby_canopy",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.9],
        tintHex: "#9099a4",
      },
      {
        id: "shaft",
        geomKey: "terminal_modern",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.9],
      },
      {
        id: "clocktower",
        geomKey: "terminal_clocktower",
        slice: "full",
        role: "trim",
        shaderMode: "glass",
        offset: [-0.34, 0, -0.24],
        scale: [0.22, 1.14, 0.22],
        squareAspect: true,
        tintHex: "#7b9bb5",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_colonnade",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.92],
        tintHex: "#b8aea0",
      },
      {
        id: "shaft",
        geomKey: "terminal_shed",
        slice: "shaft",
        role: "main",
        shaderMode: "brick",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.9],
      },
      {
        id: "clocktower",
        geomKey: "terminal_clocktower",
        slice: "full",
        role: "trim",
        shaderMode: "brick",
        offset: [0.34, 0, 0.22],
        scale: [0.24, 1.15, 0.24],
        squareAspect: true,
        tintHex: "#a15d4a",
      },
    ],
  ],
  twin_silos: [
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.9],
        tintHex: "#717a85",
      },
      {
        id: "shaft",
        geomKey: "silos_twin",
        slice: "shaft",
        role: "main",
        shaderMode: "silo",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.88],
      },
      {
        id: "crown",
        geomKey: "silos_caps_catwalk",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.88],
        tintHex: "#64748b",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.94],
        tintHex: "#69727d",
      },
      {
        id: "shaft",
        geomKey: "silos_quad",
        slice: "shaft",
        role: "main",
        shaderMode: "silo",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "silos_quad_caps",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
        tintHex: "#dce2ea",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.88],
        tintHex: "#6f7782",
      },
      {
        id: "shaft",
        geomKey: "silos_twin",
        slice: "shaft",
        role: "main",
        shaderMode: "silo",
        offset: [0, 0, 0],
        scale: [0.9, 1, 0.86],
      },
      {
        id: "crown",
        geomKey: "silos_caps_catwalk",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.9, 1.05, 0.86],
        tintHex: "#b8c4d1",
      },
    ],
  ],
  factory: [
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.92],
        tintHex: "#7c7770",
      },
      {
        id: "shaft",
        geomKey: "factory_sawtooth",
        slice: "shaft",
        role: "main",
        shaderMode: "brick",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.9],
      },
      {
        id: "stacks",
        geomKey: "factory_stacks",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, -0.1, 0],
        scale: [0.94, 1.4, 0.9],
        tintHex: "#5d554f",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.92],
        tintHex: "#77726c",
      },
      {
        id: "shaft",
        geomKey: "factory_clerestory",
        slice: "shaft",
        role: "main",
        shaderMode: "brick",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.9],
      },
      {
        id: "stacks",
        geomKey: "factory_single_stack",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, -0.1, 0],
        scale: [0.94, 1.45, 0.9],
        tintHex: "#625a54",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.92],
        tintHex: "#707478",
      },
      {
        id: "shaft",
        geomKey: "factory_sawtooth",
        slice: "shaft",
        role: "main",
        shaderMode: "brick",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "stacks",
        geomKey: "factory_single_stack",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, -0.1, 0],
        scale: [0.92, 1.4, 0.92],
        tintHex: "#525861",
      },
    ],
  ],
  archive_vault: [
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#b4afa4",
      },
      {
        id: "shaft",
        geomKey: "vault_pediment_hall",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "roof_gable_classic",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1.05, 0.94],
        tintHex: "#6b7685",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_colonnade",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#bcb5a8",
      },
      {
        id: "shaft",
        geomKey: "vault_pilasters",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "roof_hipped_slate",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.94],
        tintHex: "#7c5f50",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#adb2b8",
      },
      {
        id: "shaft",
        geomKey: "vault_pilasters",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.9, 1, 0.9],
      },
      {
        id: "crown",
        geomKey: "crown_penthouse_hvac",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.88, 0.9, 0.88],
        tintHex: "#78828e",
      },
    ],
  ],
  glass_pavilion: [
    [
      {
        id: "base",
        geomKey: "podium_lobby_canopy",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.82, 1, 0.82],
        tintHex: "#64707d",
      },
      {
        id: "shaft",
        geomKey: "pavilion_cantilever",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.94],
      },
      {
        id: "crown",
        geomKey: "crown_garden_pergola",
        slice: "crown",
        role: "foliage",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.88, 0.85, 0.88],
        tintHex: "#559a51",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.94],
        tintHex: "#9aa3ad",
      },
      {
        id: "shaft",
        geomKey: "pavilion_terraced",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.92],
      },
      {
        id: "crown",
        geomKey: "crown_skylight_atrium",
        slice: "crown",
        role: "trim",
        shaderMode: "glass",
        offset: [-0.04, 0, -0.02],
        scale: [0.84, 0.95, 0.82],
        tintHex: "#87a9c4",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_lobby_canopy",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.84, 1, 0.84],
        tintHex: "#5b6773",
      },
      {
        id: "shaft",
        geomKey: "pavilion_chamfer",
        slice: "shaft",
        role: "main",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.94],
      },
      {
        id: "crown",
        geomKey: "crown_terrace_louver",
        slice: "crown",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 0.9, 0.92],
        tintHex: "#9aa4b0",
      },
    ],
  ],
  watchtower: [
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
        tintHex: "#7b838c",
      },
      {
        id: "shaft",
        geomKey: "watchtower_core",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.82, 1, 0.82],
      },
      {
        id: "crown",
        geomKey: "watchtower_cab",
        slice: "crown",
        role: "trim",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.82, 1.15, 0.82],
        squareAspect: true,
        tintHex: "#5b899e",
      },
      {
        id: "beacon",
        geomKey: "beacon_orb",
        slice: "crown",
        role: "beacon",
        shaderMode: "solid",
        offset: [0, 1.12, 0],
        scale: [0.16, 0.25, 0.16],
        squareAspect: true,
        tintHex: "#2dd4bf",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.92, 1, 0.92],
        tintHex: "#8d8980",
      },
      {
        id: "shaft",
        geomKey: "watchtower_core",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.8, 1, 0.8],
      },
      {
        id: "crown",
        geomKey: "watchtower_cab",
        slice: "crown",
        role: "trim",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.8, 1.15, 0.8],
        squareAspect: true,
        tintHex: "#628c9c",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_dock",
        slice: "base",
        role: "podium",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.9, 1, 0.9],
        tintHex: "#6f7782",
      },
      {
        id: "shaft",
        geomKey: "tower_chamfer",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.76, 1, 0.76],
      },
      {
        id: "crown",
        geomKey: "watchtower_cab",
        slice: "crown",
        role: "trim",
        shaderMode: "glass",
        offset: [0, 0, 0],
        scale: [0.84, 1.2, 0.84],
        squareAspect: true,
        tintHex: "#557d94",
      },
    ],
  ],
  civic_kiosk: [
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.96],
        tintHex: "#c2bbb0",
      },
      {
        id: "shaft",
        geomKey: "kiosk_body",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.84, 1, 0.84],
      },
      {
        id: "crown",
        geomKey: "roof_hipped_tile",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1.15, 0.94],
        tintHex: "#b36247",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_steps",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.96, 1, 0.96],
        tintHex: "#bab4a8",
      },
      {
        id: "shaft",
        geomKey: "kiosk_body",
        slice: "shaft",
        role: "main",
        shaderMode: "brick",
        offset: [0, 0, 0],
        scale: [0.84, 1, 0.84],
      },
      {
        id: "crown",
        geomKey: "roof_gable_townhouse",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1.15, 0.94],
        tintHex: "#667483",
      },
    ],
    [
      {
        id: "base",
        geomKey: "podium_lobby_canopy",
        slice: "base",
        role: "podium",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.94, 1, 0.94],
        tintHex: "#b7afa3",
      },
      {
        id: "shaft",
        geomKey: "kiosk_body",
        slice: "shaft",
        role: "main",
        shaderMode: "stone",
        offset: [0, 0, 0],
        scale: [0.84, 1, 0.84],
      },
      {
        id: "crown",
        geomKey: "roof_hipped_tile",
        slice: "crown",
        role: "roof",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.92, 1.05, 0.92],
        tintHex: "#8d6b56",
      },
    ],
  ],
  park_stadium: [
    [
      {
        id: "turf",
        geomKey: "stadium_turf",
        slice: "base",
        role: "turf",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#549746",
      },
      {
        id: "stands",
        geomKey: "stadium_stands",
        slice: "shaft",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1.2, 0.94],
        tintHex: "#d6d1c6",
      },
      {
        id: "light_poles",
        geomKey: "stadium_floodlight_poles",
        slice: "full",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0.15, 0],
        scale: [0.96, 1.35, 0.96],
        tintHex: "#94a3b8",
      },
      {
        id: "floodlights",
        geomKey: "stadium_floodlight_lamps",
        slice: "full",
        role: "beacon",
        shaderMode: "solid",
        offset: [0, 0.15, 0],
        scale: [0.96, 1.35, 0.96],
        tintHex: "#fef9c3",
      },
    ],
    [
      {
        id: "turf",
        geomKey: "stadium_turf",
        slice: "base",
        role: "turf",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#599e4b",
      },
      {
        id: "stands",
        geomKey: "stadium_corner_stand",
        slice: "shaft",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.94, 1.15, 0.94],
        tintHex: "#d3cdc0",
      },
      {
        id: "light_poles",
        geomKey: "stadium_floodlight_poles",
        slice: "full",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0.15, 0],
        scale: [0.96, 1.3, 0.96],
        tintHex: "#94a3b8",
      },
      {
        id: "floodlights",
        geomKey: "stadium_floodlight_lamps",
        slice: "full",
        role: "beacon",
        shaderMode: "solid",
        offset: [0, 0.15, 0],
        scale: [0.96, 1.3, 0.96],
        tintHex: "#fef9c3",
      },
    ],
    [
      {
        id: "turf",
        geomKey: "stadium_turf",
        slice: "base",
        role: "turf",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.98, 1, 0.98],
        tintHex: "#519244",
      },
      {
        id: "amphitheater",
        geomKey: "stadium_amphitheater",
        slice: "shaft",
        role: "trim",
        shaderMode: "solid",
        offset: [0, 0, 0],
        scale: [0.92, 1.1, 0.92],
        tintHex: "#cfc6b6",
      },
    ],
  ],
};

export function getArchetypeKitForFile(file: FileMetric): {
  variant: number;
  parts: BuildingPartSpec[];
} {
  const variants =
    ARCHETYPE_VARIANT_KITS[file.building_archetype] ?? ARCHETYPE_VARIANT_KITS.office_tower;
  const variant = buildingVariantIndex(file.file_path, variants.length);
  return { variant, parts: variants[variant] };
}

const sharedPartCache = new Map<string, THREE.BufferGeometry>();

export function getPartGeometry(geomKey: string): THREE.BufferGeometry {
  const hit = sharedPartCache.get(geomKey);
  if (hit) return hit;

  const builder = PART_GEOM_BUILDERS[geomKey];
  const geom = builder ? builder() : composePieces([mkBox(1, 1, 1, 0, 0, 0)]);
  sharedPartCache.set(geomKey, geom);
  return geom;
}

export function getSharedGeometrySet(): Set<THREE.BufferGeometry> {
  return new Set(sharedPartCache.values());
}

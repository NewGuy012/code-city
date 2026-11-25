import * as THREE from "three";

import type { BuildingArchetype, DataMapMode, FileMetric } from "../types/city";
import { WORLD_CENTER_X, WORLD_CENTER_Z } from "./cameraStore";
import {
  buildingPalette,
  buildingVariantIndex,
  computeBuildingHeight,
  hashFilePath,
} from "./cityTheme";

export type PrimitiveShapeKey = "box" | "cylinder" | "dome" | "prism" | "oct";

export interface BuildingBlockPart {
  shape: PrimitiveShapeKey;
  role: "main" | "cap" | "turf" | "beacon";
  ox: number;
  oy: number;
  oz: number;
  sx: number;
  sy: number;
  sz: number;
  square?: boolean;
  tintHex?: string;
}

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

const ARCHETYPE_BLOCK_PARTS: Record<BuildingArchetype, BuildingBlockPart[]> = {
  office_tower: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.9, sy: 0.86, sz: 0.9 },
    {
      shape: "box",
      role: "cap",
      ox: 0,
      oy: 0.86,
      oz: 0,
      sx: 0.62,
      sy: 0.14,
      sz: 0.62,
      tintHex: "#cbd5e1",
    },
    {
      shape: "box",
      role: "beacon",
      ox: 0,
      oy: 1.0,
      oz: 0,
      sx: 0.1,
      sy: 0.1,
      sz: 0.1,
      square: true,
      tintHex: "#fde68a",
    },
  ],
  city_hall: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.92, sy: 0.72, sz: 0.92 },
    {
      shape: "dome",
      role: "cap",
      ox: 0,
      oy: 0.72,
      oz: 0,
      sx: 0.7,
      sy: 0.28,
      sz: 0.7,
      square: true,
      tintHex: "#5f9d86",
    },
    {
      shape: "cylinder",
      role: "beacon",
      ox: 0,
      oy: 0.98,
      oz: 0,
      sx: 0.08,
      sy: 0.14,
      sz: 0.08,
      square: true,
      tintHex: "#fde047",
    },
  ],
  grand_terminal: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.95, sy: 0.76, sz: 0.9 },
    {
      shape: "prism",
      role: "cap",
      ox: 0,
      oy: 0.76,
      oz: 0,
      sx: 0.86,
      sy: 0.22,
      sz: 0.78,
      tintHex: "#93c5fd",
    },
    {
      shape: "box",
      role: "cap",
      ox: 0.33,
      oy: 0,
      oz: -0.24,
      sx: 0.24,
      sy: 1.12,
      sz: 0.24,
      square: true,
      tintHex: "#cbd5e1",
    },
    {
      shape: "box",
      role: "beacon",
      ox: 0.33,
      oy: 1.12,
      oz: -0.24,
      sx: 0.14,
      sy: 0.09,
      sz: 0.14,
      square: true,
      tintHex: "#fef08a",
    },
  ],
  twin_silos: [
    { shape: "cylinder", role: "main", ox: -0.24, oy: 0, oz: 0, sx: 0.43, sy: 0.88, sz: 0.82 },
    { shape: "cylinder", role: "main", ox: 0.24, oy: 0, oz: 0, sx: 0.43, sy: 0.88, sz: 0.82 },
    {
      shape: "dome",
      role: "cap",
      ox: -0.24,
      oy: 0.88,
      oz: 0,
      sx: 0.4,
      sy: 0.12,
      sz: 0.4,
      square: true,
      tintHex: "#cbd5e1",
    },
    {
      shape: "dome",
      role: "cap",
      ox: 0.24,
      oy: 0.88,
      oz: 0,
      sx: 0.4,
      sy: 0.12,
      sz: 0.4,
      square: true,
      tintHex: "#cbd5e1",
    },
  ],
  factory: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.94, sy: 0.72, sz: 0.9 },
    {
      shape: "prism",
      role: "cap",
      ox: -0.05,
      oy: 0.72,
      oz: 0,
      sx: 0.8,
      sy: 0.26,
      sz: 0.56,
      tintHex: "#7c7770",
    },
    {
      shape: "cylinder",
      role: "cap",
      ox: 0.32,
      oy: 0,
      oz: -0.22,
      sx: 0.18,
      sy: 1.32,
      sz: 0.18,
      square: true,
      tintHex: "#475569",
    },
  ],
  archive_vault: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.92, sy: 0.74, sz: 0.92 },
    {
      shape: "prism",
      role: "cap",
      ox: 0,
      oy: 0.74,
      oz: 0,
      sx: 0.96,
      sy: 0.26,
      sz: 0.96,
      tintHex: "#6b7685",
    },
  ],
  glass_pavilion: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.95, sy: 0.82, sz: 0.92 },
    {
      shape: "box",
      role: "cap",
      ox: 0,
      oy: 0.82,
      oz: 0,
      sx: 0.72,
      sy: 0.18,
      sz: 0.7,
      tintHex: "#5da05a",
    },
  ],
  watchtower: [
    {
      shape: "cylinder",
      role: "main",
      ox: 0,
      oy: 0,
      oz: 0,
      sx: 0.58,
      sy: 0.76,
      sz: 0.58,
      square: true,
    },
    {
      shape: "oct",
      role: "cap",
      ox: 0,
      oy: 0.76,
      oz: 0,
      sx: 0.84,
      sy: 0.24,
      sz: 0.84,
      square: true,
      tintHex: "#5b899e",
    },
    {
      shape: "cylinder",
      role: "beacon",
      ox: 0,
      oy: 1.0,
      oz: 0,
      sx: 0.14,
      sy: 0.16,
      sz: 0.14,
      square: true,
      tintHex: "#2dd4bf",
    },
  ],
  civic_kiosk: [
    { shape: "box", role: "main", ox: 0, oy: 0, oz: 0, sx: 0.86, sy: 0.68, sz: 0.86 },
    {
      shape: "prism",
      role: "cap",
      ox: 0,
      oy: 0.68,
      oz: 0,
      sx: 0.96,
      sy: 0.32,
      sz: 0.96,
      tintHex: "#b36247",
    },
  ],
  park_stadium: [
    {
      shape: "box",
      role: "turf",
      ox: 0,
      oy: 0,
      oz: 0,
      sx: 0.96,
      sy: 0.24,
      sz: 0.96,
      tintHex: "#549746",
    },
    {
      shape: "cylinder",
      role: "cap",
      ox: 0,
      oy: 0.22,
      oz: 0,
      sx: 0.76,
      sy: 0.12,
      sz: 0.64,
      tintHex: "#b85d43",
    },
    {
      shape: "box",
      role: "cap",
      ox: 0,
      oy: 0.24,
      oz: -0.34,
      sx: 0.82,
      sy: 0.56,
      sz: 0.22,
      tintHex: "#d6d1c6",
    },
  ],
};

export function getBlockPartsForFile(file: FileMetric): BuildingBlockPart[] {
  const parts =
    ARCHETYPE_BLOCK_PARTS[file.building_archetype] ?? ARCHETYPE_BLOCK_PARTS.office_tower;
  if (file.building_archetype === "office_tower" && buildingVariantIndex(file.file_path, 3) !== 0) {
    return parts.slice(0, 2);
  }
  return parts;
}

export function computeBlockPartTransform(
  part: BuildingBlockPart,
  localW: number,
  localD: number,
  totalH: number,
  yOrigin: number,
  cx: number,
  cz: number,
  rotY: number,
): { x: number; y: number; z: number; sx: number; sy: number; sz: number } {
  const sx = (part.square ? Math.min(localW, localD) : localW) * part.sx;
  const sz = (part.square ? Math.min(localW, localD) : localD) * part.sz;
  const sy = totalH * part.sy;
  const oxLocal = part.ox * localW;
  const ozLocal = part.oz * localD;
  const cosR = rotY === 0 ? 1 : Math.cos(rotY);
  const sinR = rotY === 0 ? 0 : Math.sin(rotY);
  return {
    x: cx + oxLocal * cosR + ozLocal * sinR,
    y: yOrigin + part.oy * totalH,
    z: cz - oxLocal * sinR + ozLocal * cosR,
    sx: Math.max(0.1, sx),
    sy: Math.max(0.1, sy),
    sz: Math.max(0.1, sz),
  };
}

const primitiveCache = new Map<PrimitiveShapeKey, THREE.BufferGeometry>();
const sharedPrimitiveSet = new Set<THREE.BufferGeometry>();

/** Shared normalized primitive geometries spanning y in [0, 1] and x,z in [-0.5, 0.5]. */
export function getPrimitiveGeometry(shape: PrimitiveShapeKey): THREE.BufferGeometry {
  const hit = primitiveCache.get(shape);
  if (hit) return hit;

  let geom: THREE.BufferGeometry;
  if (shape === "cylinder") {
    geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    geom.translate(0, 0.5, 0);
  } else if (shape === "dome") {
    geom = new THREE.SphereGeometry(0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    geom.scale(1, 2, 1);
  } else if (shape === "prism") {
    geom = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
    geom.rotateY(Math.PI * 0.25);
    geom.translate(0, 0.5, 0);
  } else if (shape === "oct") {
    geom = new THREE.CylinderGeometry(0.56, 0.44, 1, 8);
    geom.translate(0, 0.5, 0);
  } else {
    geom = new THREE.BoxGeometry(1, 1, 1);
    geom.translate(0, 0.5, 0);
  }

  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  primitiveCache.set(shape, geom);
  sharedPrimitiveSet.add(geom);
  return geom;
}

export function isSharedPrimitive(geom: THREE.BufferGeometry): boolean {
  return sharedPrimitiveSet.has(geom);
}

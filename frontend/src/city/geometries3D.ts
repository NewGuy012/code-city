import * as THREE from "three";

import type { BuildingArchetype, DataMapMode, FileMetric } from "../types/city";
import type { FacadeStyle } from "./textures3D";

export const ARCHETYPE_COLOR_HEX: Record<BuildingArchetype, string> = {
  grand_terminal: "#0ea5e9",
  city_hall: "#f59e0b",
  archive_vault: "#94a3b8",
  twin_silos: "#6366f1",
  factory: "#ea580c",
  office_tower: "#3b82f6",
  glass_pavilion: "#06b6d4",
  watchtower: "#14b8a6",
  civic_kiosk: "#64748b",
  park_stadium: "#22c55e",
};

const LANG_COLORS: Record<string, string> = {
  python: "#3b82f6",
  typescript: "#eab308",
  javascript: "#f59e0b",
  rust: "#f97316",
  go: "#06b6d4",
  other: "#94a3b8",
};

export function buildingHeight3D(file: FileMetric): number {
  if (file.building_archetype === "park_stadium") return 1.2;
  const slocFactor = Math.log2(Math.max(8, file.sloc)) * 1.45;
  const compFactor = Math.min(9, file.max_complexity * 0.72);
  const symFactor = Math.min(4, file.symbol_count * 0.3);
  const roleBoost =
    file.building_archetype === "city_hall"
      ? 5
      : file.building_archetype === "grand_terminal"
        ? 3
        : 0;
  return Math.max(2.5, Math.min(28, slocFactor + compFactor + symFactor + roleBoost));
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
    return "#334155";
  }
  if (selectedFile && file.file_path === selectedFile) return "#fef08a";

  if (dataMap === "living") {
    return ARCHETYPE_COLOR_HEX[file.building_archetype] ?? "#3b82f6";
  }
  if (dataMap === "languages") {
    return LANG_COLORS[file.language] ?? LANG_COLORS.other;
  }
  if (dataMap === "hotspots") {
    if (file.hotspot_score >= 16) return "#ef4444";
    if (file.hotspot_score >= 6) return "#f97316";
    if (file.hotspot_score >= 1.5) return "#eab308";
    return "#475569";
  }
  if (dataMap === "pollution") {
    const debt = file.lint_issue_count + (file.format_drift ? 2 : 0);
    if (debt >= 5) return "#a855f7";
    if (debt >= 1) return "#d97706";
    return "#10b981";
  }
  if (dataMap === "bus_factor") {
    if (file.distinct_authors_90d <= 1) {
      return file.condition_flags?.lone_keeper ? "#e11d48" : "#eab308";
    }
    return file.distinct_authors_90d === 2 ? "#3b82f6" : "#14b8a6";
  }
  return file.format_drift ? "#d946ef" : "#0ea5e9";
}

export type PartGeomKind = "box" | "cylinder" | "cone4" | "sphere" | "arch_shed" | "taper_stack";
export type PartMaterialRole = "main" | "podium" | "trim" | "beacon" | "turf" | "foliage";

export interface ArchetypePartSpec {
  id: string;
  geom: PartGeomKind;
  role: PartMaterialRole;
  /** Offset as fraction of (bw, h, bd) */
  offset: [number, number, number];
  /** Scale as fraction of (bw, h, bd); fixedY overrides Y when > 0 */
  scale: [number, number, number];
  fixedY?: number;
  fixedXZ?: number;
  rotY?: number;
  facadeStyle?: FacadeStyle;
  tintHex?: string;
}

export const ARCHETYPE_KITS: Record<BuildingArchetype, ArchetypePartSpec[]> = {
  office_tower: [
    {
      id: "podium",
      geom: "box",
      role: "podium",
      offset: [0, 0.08, 0],
      scale: [0.98, 0.16, 0.98],
      tintHex: "#64748b",
    },
    {
      id: "shaft",
      geom: "box",
      role: "main",
      facadeStyle: "glass",
      offset: [0, 0.54, 0],
      scale: [0.82, 0.78, 0.82],
    },
    {
      id: "penthouse",
      geom: "box",
      role: "trim",
      offset: [0, 0.96, 0],
      scale: [0.46, 0.1, 0.46],
      tintHex: "#cbd5e1",
    },
  ],
  city_hall: [
    {
      id: "plinth",
      geom: "box",
      role: "podium",
      offset: [0, 0.07, 0],
      scale: [1.0, 0.14, 1.0],
      tintHex: "#cbd5e1",
    },
    {
      id: "colonnade",
      geom: "box",
      role: "main",
      facadeStyle: "stone",
      offset: [0, 0.46, 0],
      scale: [0.84, 0.64, 0.84],
    },
    {
      id: "crown",
      geom: "cylinder",
      role: "trim",
      offset: [0, 0.86, 0],
      scale: [0.54, 0.18, 0.54],
      tintHex: "#fde68a",
    },
    {
      id: "spire",
      geom: "cone4",
      role: "beacon",
      offset: [0, 1.04, 0],
      scale: [0.2, 0.22, 0.2],
      tintHex: "#fef08a",
    },
  ],
  grand_terminal: [
    {
      id: "hall",
      geom: "box",
      role: "main",
      facadeStyle: "glass",
      offset: [0, 0.34, 0],
      scale: [0.94, 0.68, 0.78],
    },
    {
      id: "arch_roof",
      geom: "arch_shed",
      role: "trim",
      offset: [0, 0.68, 0],
      scale: [0.92, 0.24, 0.74],
      tintHex: "#bae6fd",
    },
    {
      id: "clocktower",
      geom: "box",
      role: "podium",
      offset: [0.34, 0.58, -0.26],
      scale: [0.24, 1.16, 0.24],
      tintHex: "#0284c7",
    },
    {
      id: "beacon_tip",
      geom: "sphere",
      role: "beacon",
      offset: [0.34, 1.2, -0.26],
      scale: [0.16, 0.16, 0.16],
      fixedY: 0.45,
      tintHex: "#fef08a",
    },
  ],
  twin_silos: [
    {
      id: "slab",
      geom: "box",
      role: "podium",
      offset: [0, 0.06, 0],
      scale: [0.96, 0.12, 0.96],
      tintHex: "#334155",
    },
    {
      id: "silo_left",
      geom: "cylinder",
      role: "main",
      facadeStyle: "silo",
      offset: [-0.23, 0.52, 0],
      scale: [0.42, 0.82, 0.44],
    },
    {
      id: "silo_right",
      geom: "cylinder",
      role: "main",
      facadeStyle: "silo",
      offset: [0.23, 0.52, 0],
      scale: [0.42, 0.82, 0.44],
    },
    {
      id: "catwalk",
      geom: "box",
      role: "trim",
      offset: [0, 0.82, 0],
      scale: [0.56, 0.08, 0.16],
      tintHex: "#e0e7ff",
    },
  ],
  factory: [
    {
      id: "hall",
      geom: "box",
      role: "main",
      facadeStyle: "industrial",
      offset: [-0.04, 0.36, 0],
      scale: [0.88, 0.72, 0.88],
    },
    {
      id: "monitor",
      geom: "box",
      role: "trim",
      offset: [-0.12, 0.79, 0],
      scale: [0.45, 0.14, 0.72],
      tintHex: "#fed7aa",
    },
    {
      id: "stack1",
      geom: "taper_stack",
      role: "podium",
      offset: [0.32, 0.75, -0.2],
      scale: [0.16, 0.75, 0.16],
      tintHex: "#57534e",
    },
    {
      id: "stack2",
      geom: "taper_stack",
      role: "podium",
      offset: [0.32, 0.75, 0.2],
      scale: [0.16, 0.75, 0.16],
      tintHex: "#57534e",
    },
  ],
  archive_vault: [
    {
      id: "steps",
      geom: "box",
      role: "podium",
      offset: [0, 0.08, 0],
      scale: [1.0, 0.16, 1.0],
      tintHex: "#64748b",
    },
    {
      id: "vault",
      geom: "box",
      role: "main",
      facadeStyle: "stone",
      offset: [0, 0.5, 0],
      scale: [0.82, 0.7, 0.82],
    },
    {
      id: "pediment",
      geom: "cone4",
      role: "trim",
      offset: [0, 0.94, 0],
      scale: [0.88, 0.2, 0.88],
      rotY: Math.PI * 0.25,
      tintHex: "#e2e8f0",
    },
  ],
  glass_pavilion: [
    {
      id: "lobby",
      geom: "box",
      role: "podium",
      offset: [0, 0.12, 0],
      scale: [0.76, 0.24, 0.76],
      tintHex: "#334155",
    },
    {
      id: "cantilever",
      geom: "box",
      role: "main",
      facadeStyle: "glass",
      offset: [0, 0.56, 0],
      scale: [0.96, 0.66, 0.94],
    },
    {
      id: "terrace",
      geom: "box",
      role: "foliage",
      offset: [0, 0.92, 0],
      scale: [0.64, 0.08, 0.64],
      tintHex: "#22c55e",
    },
  ],
  watchtower: [
    {
      id: "core",
      geom: "box",
      role: "main",
      facadeStyle: "industrial",
      offset: [0, 0.42, 0],
      scale: [0.78, 0.84, 0.78],
    },
    {
      id: "turret",
      geom: "cylinder",
      role: "podium",
      offset: [0, 0.92, 0],
      scale: [0.46, 0.18, 0.46],
      tintHex: "#0f766e",
    },
    {
      id: "radar",
      geom: "cone4",
      role: "beacon",
      offset: [0.1, 1.06, -0.08],
      scale: [0.34, 0.14, 0.34],
      tintHex: "#2dd4bf",
    },
  ],
  civic_kiosk: [
    {
      id: "plaza",
      geom: "box",
      role: "podium",
      offset: [0, 0.06, 0],
      scale: [0.96, 0.12, 0.96],
      tintHex: "#94a3b8",
    },
    {
      id: "body",
      geom: "box",
      role: "main",
      facadeStyle: "stone",
      offset: [0, 0.4, 0],
      scale: [0.74, 0.58, 0.74],
    },
    {
      id: "hip_roof",
      geom: "cone4",
      role: "trim",
      offset: [0, 0.8, 0],
      scale: [0.84, 0.24, 0.84],
      rotY: Math.PI * 0.25,
      tintHex: "#cbd5e1",
    },
  ],
  park_stadium: [
    {
      id: "turf",
      geom: "box",
      role: "turf",
      offset: [0, 0.15, 0],
      scale: [0.98, 0.3, 0.98],
      tintHex: "#22c55e",
    },
    {
      id: "bleacher_n",
      geom: "box",
      role: "trim",
      offset: [0, 0.55, -0.38],
      scale: [0.84, 0.65, 0.18],
      tintHex: "#cbd5e1",
    },
    {
      id: "bleacher_s",
      geom: "box",
      role: "trim",
      offset: [0, 0.55, 0.38],
      scale: [0.84, 0.65, 0.18],
      tintHex: "#cbd5e1",
    },
    {
      id: "tree_nw",
      geom: "sphere",
      role: "foliage",
      offset: [-0.36, 0.85, -0.15],
      scale: [0.22, 0.95, 0.22],
      fixedY: 0.7,
      tintHex: "#16a34a",
    },
    {
      id: "tree_se",
      geom: "sphere",
      role: "foliage",
      offset: [0.36, 0.85, 0.15],
      scale: [0.22, 0.95, 0.22],
      fixedY: 0.7,
      tintHex: "#15803d",
    },
  ],
};

const sharedGeoms = new Map<PartGeomKind, THREE.BufferGeometry>();

export function getSharedPartGeometry(kind: PartGeomKind): THREE.BufferGeometry {
  const hit = sharedGeoms.get(kind);
  if (hit) return hit;

  let geom: THREE.BufferGeometry;
  if (kind === "cylinder") {
    geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  } else if (kind === "taper_stack") {
    geom = new THREE.CylinderGeometry(0.28, 0.5, 1, 10);
  } else if (kind === "cone4") {
    geom = new THREE.ConeGeometry(0.68, 1, 4);
  } else if (kind === "sphere") {
    geom = new THREE.SphereGeometry(0.5, 12, 10);
  } else if (kind === "arch_shed") {
    geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1, false, 0, Math.PI);
    geom.rotateZ(Math.PI * 0.5);
    geom.rotateY(Math.PI * 0.5);
  } else {
    geom = new THREE.BoxGeometry(1, 1, 1);
  }
  sharedGeoms.set(kind, geom);
  return geom;
}

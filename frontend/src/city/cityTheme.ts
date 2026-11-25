import type {
  BlastRadiusResult,
  BuildingArchetype,
  CochangePair,
  DataMapMode,
  FileMetric,
  ZoneType,
} from "../types/city";

export interface ShadePalette {
  roof: string;
  left: string;
  right: string;
  accent: string;
}

export interface ZoneStyle {
  fill: string;
  border: string;
  ground: string;
  sidewalk: string;
  plaza: string;
  label: string;
}

export function hashFilePath(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function buildingVariantIndex(filePath: string, variants = 3): number {
  return hashFilePath(filePath) % Math.max(1, variants);
}

export function isAnalyticalDataMap(dataMap: DataMapMode): boolean {
  return dataMap !== "living";
}

export const ZONE_PALETTES: Record<ZoneType, ZoneStyle> = {
  harbor_gates: {
    fill: "#dce3ea",
    border: "#3b82f6",
    ground: "#6d9a5b",
    sidewalk: "#cbd3db",
    plaza: "#d8d4ca",
    label: "Harbor & Gates",
  },
  downtown_core: {
    fill: "#d6dce4",
    border: "#d97706",
    ground: "#689557",
    sidewalk: "#d2d7de",
    plaza: "#c9cfd8",
    label: "Downtown Core",
  },
  vaults_reservoir: {
    fill: "#d9d6df",
    border: "#7c3aed",
    ground: "#6a9559",
    sidewalk: "#ced3db",
    plaza: "#d5d1c8",
    label: "Vaults & Reservoir",
  },
  industrial_quarter: {
    fill: "#c9c4ba",
    border: "#ea580c",
    ground: "#7c8860",
    sidewalk: "#b8b3aa",
    plaza: "#a29b90",
    label: "Industrial Quarter",
  },
  gallery_storefront: {
    fill: "#dee3e8",
    border: "#db2777",
    ground: "#72a05e",
    sidewalk: "#d6dbe1",
    plaza: "#e2dcd2",
    label: "Gallery District",
  },
  civic_utilities: {
    fill: "#d4ddd9",
    border: "#0d9488",
    ground: "#6c9b5c",
    sidewalk: "#cbd3cf",
    plaza: "#ccd4ce",
    label: "Civic & Utilities",
  },
  greenbelt_parks: {
    fill: "#5b9a4f",
    border: "#16a34a",
    ground: "#528f47",
    sidewalk: "#bac4b1",
    plaza: "#7db068",
    label: "Greenbelt Parks",
  },
  supply_docks: {
    fill: "#cbd2db",
    border: "#2563eb",
    ground: "#788d6e",
    sidewalk: "#c3c8ce",
    plaza: "#b7b0a4",
    label: "Supply Docks",
  },
};

const LIVING_ARCHETYPE_VARIANTS: Record<BuildingArchetype, ShadePalette[]> = {
  grand_terminal: [
    { roof: "#8bb4cf", left: "#95a3b3", right: "#637080", accent: "#fef08a" },
    { roof: "#96bfd4", left: "#b6afa2", right: "#847c70", accent: "#fde68a" },
    { roof: "#7fa8c4", left: "#8897a8", right: "#556474", accent: "#fef9c3" },
  ],
  city_hall: [
    { roof: "#67a68e", left: "#e2d8c5", right: "#b3a58f", accent: "#f6d465" },
    { roof: "#70ad94", left: "#dbd2c4", right: "#a99e8f", accent: "#fde047" },
    { roof: "#5b9780", left: "#e6dccb", right: "#baa991", accent: "#f5c451" },
  ],
  archive_vault: [
    { roof: "#76808d", left: "#d2cabd", right: "#9c9384", accent: "#e2e8f0" },
    { roof: "#8d6b57", left: "#cfc5b4", right: "#9a8e7c", accent: "#f1f5f9" },
    { roof: "#6a7582", left: "#c4c9cf", right: "#8b929b", accent: "#e2e8f0" },
  ],
  twin_silos: [
    { roof: "#dde3ea", left: "#bfc8d2", right: "#8c97a4", accent: "#93c5fd" },
    { roof: "#d4cec2", left: "#c8c0b3", right: "#958d80", accent: "#cbd5e1" },
    { roof: "#cbd5e1", left: "#aeb8c4", right: "#798594", accent: "#bfdbfe" },
  ],
  factory: [
    { roof: "#7b828b", left: "#a85c47", right: "#743b2b", accent: "#fb923c" },
    { roof: "#717982", left: "#b57d52", right: "#7f5333", accent: "#fdba74" },
    { roof: "#6d747d", left: "#8d6356", right: "#5f3f36", accent: "#f59e0b" },
  ],
  office_tower: [
    { roof: "#94a3b8", left: "#587d9c", right: "#36546e", accent: "#cbd5e1" },
    { roof: "#cbd5e1", left: "#a4aeb9", right: "#6f7b89", accent: "#e2e8f0" },
    { roof: "#8d9aa8", left: "#4e677d", right: "#2f4356", accent: "#bae6fd" },
  ],
  glass_pavilion: [
    { roof: "#5da05a", left: "#6da2ba", right: "#467085", accent: "#e2e8f0" },
    { roof: "#66a961", left: "#79adc2", right: "#4f7c91", accent: "#f1f5f9" },
    { roof: "#579855", left: "#6193aa", right: "#3d6578", accent: "#d1fae5" },
  ],
  watchtower: [
    { roof: "#758290", left: "#9ea7b1", right: "#6a7480", accent: "#5eead4" },
    { roof: "#6b7987", left: "#a9a399", right: "#756f66", accent: "#99f6e4" },
    { roof: "#7c8896", left: "#919ba7", right: "#5f6975", accent: "#7dd3fc" },
  ],
  civic_kiosk: [
    { roof: "#b36247", left: "#d2c1ab", right: "#9c8b75", accent: "#f8fafc" },
    { roof: "#6c7988", left: "#c8bca8", right: "#928673", accent: "#f1f5f9" },
    { roof: "#8c6954", left: "#c49678", right: "#8f654b", accent: "#fef3c7" },
  ],
  park_stadium: [
    { roof: "#5da44c", left: "#559845", right: "#3b6e30", accent: "#e5dec9" },
    { roof: "#64ac52", left: "#5b9e4b", right: "#407535", accent: "#dfd7c0" },
    { roof: "#569c47", left: "#4f9040", right: "#37682d", accent: "#ece5d3" },
  ],
};

const LANGUAGE_PALETTES: Record<string, ShadePalette> = {
  python: { roof: "#60a5fa", left: "#2563eb", right: "#1e3a8a", accent: "#fde047" },
  typescript: { roof: "#fde047", left: "#eab308", right: "#854d0e", accent: "#fef9c3" },
  javascript: { roof: "#fcd34d", left: "#d97706", right: "#78350f", accent: "#fef3c7" },
  rust: { roof: "#fdba74", left: "#ea580c", right: "#7c2d12", accent: "#ffedd5" },
  go: { roof: "#67e8f9", left: "#06b6d4", right: "#155e75", accent: "#cffafe" },
  other: { roof: "#cbd5e1", left: "#64748b", right: "#334155", accent: "#f1f5f9" },
};

export function buildingPaletteForVariant(
  archetype: BuildingArchetype,
  variantIdx: number,
): ShadePalette {
  const variants = LIVING_ARCHETYPE_VARIANTS[archetype] ?? LIVING_ARCHETYPE_VARIANTS.office_tower;
  return variants[((variantIdx % variants.length) + variants.length) % variants.length];
}

export function buildingPalette(file: FileMetric, dataMap: DataMapMode): ShadePalette {
  if (dataMap === "living") {
    return buildingPaletteForVariant(
      file.building_archetype,
      buildingVariantIndex(file.file_path, 3),
    );
  }
  if (dataMap === "languages") {
    return LANGUAGE_PALETTES[file.language] ?? LANGUAGE_PALETTES.other;
  }
  if (dataMap === "hotspots") {
    if (file.hotspot_score >= 16) {
      return { roof: "#fca5a5", left: "#ef4444", right: "#991b1b", accent: "#fef2f2" };
    }
    if (file.hotspot_score >= 6) {
      return { roof: "#fdba74", left: "#f97316", right: "#9a3412", accent: "#fff7ed" };
    }
    if (file.hotspot_score >= 1.5) {
      return { roof: "#fde68a", left: "#eab308", right: "#854d0e", accent: "#fefce8" };
    }
    return { roof: "#cbd5e1", left: "#94a3b8", right: "#64748b", accent: "#e2e8f0" };
  }
  if (dataMap === "pollution") {
    const debt = file.lint_issue_count + (file.format_drift ? 2 : 0);
    if (debt >= 5) {
      return { roof: "#e879f9", left: "#a855f7", right: "#581c87", accent: "#fae8ff" };
    }
    if (debt >= 1) {
      return { roof: "#fcd34d", left: "#d97706", right: "#78350f", accent: "#fef3c7" };
    }
    return { roof: "#6ee7b7", left: "#10b981", right: "#065f46", accent: "#d1fae5" };
  }
  if (dataMap === "bus_factor") {
    if (file.distinct_authors_90d <= 1) {
      return file.condition_flags?.lone_keeper
        ? { roof: "#fda4af", left: "#e11d48", right: "#881337", accent: "#ffe4e6" }
        : { roof: "#fde047", left: "#ca8a04", right: "#713f12", accent: "#fef9c3" };
    }
    if (file.distinct_authors_90d === 2) {
      return { roof: "#93c5fd", left: "#3b82f6", right: "#1e3a8a", accent: "#dbeafe" };
    }
    return { roof: "#5eead4", left: "#0d9488", right: "#134e4a", accent: "#ccfbf1" };
  }
  return file.format_drift
    ? { roof: "#f0abfc", left: "#c026d3", right: "#701a75", accent: "#fdf4ff" }
    : { roof: "#7dd3fc", left: "#0284c7", right: "#0c4a6e", accent: "#e0f2fe" };
}

export function computeBuildingHeight(file: FileMetric): number {
  if (file.building_archetype === "park_stadium") return 6;
  const slocFactor = Math.log2(Math.max(8, file.sloc)) * 4.2;
  const compFactor = Math.min(26, file.max_complexity * 2.1);
  const symbolFactor = Math.min(12, file.symbol_count * 0.9);
  const roleBoost =
    file.building_archetype === "city_hall"
      ? 14
      : file.building_archetype === "grand_terminal"
        ? 8
        : 0;
  return Math.max(12, Math.min(86, slocFactor + compFactor + symbolFactor + roleBoost));
}

const COMMUTER_CAR_SWATCHES = ["#e2e8f0", "#cbd5e1", "#dc2626", "#2563eb", "#f59e0b", "#475569"];

export function commuterCarColor(id: string): string {
  return COMMUTER_CAR_SWATCHES[hashFilePath(id) % COMMUTER_CAR_SWATCHES.length];
}

export function vehicleColor(
  type: "request_car" | "cycle_car" | "sweeper" | "fire_truck" | "crew" | "cargo_ship",
  jammed = false,
  flashPhase = false,
): string {
  if (jammed) return "#ef4444";
  if (type === "fire_truck") return flashPhase ? "#fef08a" : "#f43f5e";
  if (type === "sweeper") return "#22c55e";
  if (type === "crew") return "#fb923c";
  if (type === "cycle_car") return "#e879f9";
  if (type === "cargo_ship") return "#d97706";
  return "#e2e8f0";
}

export function buildImpactedHopMap(blastRadius: BlastRadiusResult | null): Map<string, number> {
  const map = new Map<string, number>();
  if (blastRadius) {
    for (const node of blastRadius.impacted_files) {
      map.set(node.file_path, node.hop_distance);
    }
  }
  return map;
}

export function selectFaultLines(
  cochanges: CochangePair[],
  selectedFile: string | null,
  blastRadius: BlastRadiusResult | null,
): CochangePair[] {
  if (blastRadius?.fault_lines?.length) return blastRadius.fault_lines;
  if (selectedFile) {
    return cochanges.filter((c) => c.file_a === selectedFile || c.file_b === selectedFile);
  }
  return [];
}

export function canvasCursorClass(
  activeTool: string,
  hasHover: boolean,
  yawRotateMode = false,
): string {
  if (yawRotateMode) return "cursor-ew-resize";
  if (activeTool !== "inspect") return "cursor-crosshair";
  return hasHover ? "cursor-pointer" : "cursor-grab active:cursor-grabbing";
}

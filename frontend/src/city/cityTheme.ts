import type { BuildingArchetype, DataMapMode, FileMetric, ZoneType } from "../types/city";

export interface ShadePalette {
  roof: string;
  left: string;
  right: string;
  accent: string;
}

export const ZONE_PALETTES: Record<ZoneType, { fill: string; border: string; label: string }> = {
  harbor_gates: { fill: "#18334e", border: "#38bdf8", label: "Harbor & Gates" },
  downtown_core: { fill: "#1e293b", border: "#fbbf24", label: "Downtown Core" },
  vaults_reservoir: { fill: "#28263b", border: "#a78bfa", label: "Vaults & Reservoir" },
  industrial_quarter: { fill: "#2b251c", border: "#f97316", label: "Industrial Quarter" },
  gallery_storefront: { fill: "#1d2d44", border: "#f472b6", label: "Gallery District" },
  civic_utilities: { fill: "#1a2f35", border: "#2dd4bf", label: "Civic & Utilities" },
  greenbelt_parks: { fill: "#153625", border: "#4ade80", label: "Greenbelt Parks" },
  supply_docks: { fill: "#172b3e", border: "#60a5fa", label: "Supply Docks" },
};

export const ARCHETYPE_PALETTES: Record<BuildingArchetype, ShadePalette> = {
  grand_terminal: { roof: "#38bdf8", left: "#0284c7", right: "#075985", accent: "#fef08a" },
  city_hall: { roof: "#fde68a", left: "#d97706", right: "#92400e", accent: "#fffbeb" },
  archive_vault: { roof: "#cbd5e1", left: "#94a3b8", right: "#475569", accent: "#a78bfa" },
  twin_silos: { roof: "#a5b4fc", left: "#6366f1", right: "#3730a3", accent: "#e0e7ff" },
  factory: { roof: "#fdba74", left: "#ea580c", right: "#9a3412", accent: "#fed7aa" },
  office_tower: { roof: "#93c5fd", left: "#3b82f6", right: "#1e40af", accent: "#dbeafe" },
  glass_pavilion: { roof: "#67e8f9", left: "#06b6d4", right: "#155e75", accent: "#f472b6" },
  watchtower: { roof: "#5eead4", left: "#0d9488", right: "#115e59", accent: "#99f6e4" },
  civic_kiosk: { roof: "#94a3b8", left: "#64748b", right: "#334155", accent: "#e2e8f0" },
  park_stadium: { roof: "#4ade80", left: "#16a34a", right: "#14532d", accent: "#bbf7d0" },
};

const LANGUAGE_PALETTES: Record<string, ShadePalette> = {
  python: { roof: "#60a5fa", left: "#2563eb", right: "#1e3a8a", accent: "#fde047" },
  typescript: { roof: "#fde047", left: "#eab308", right: "#854d0e", accent: "#fef9c3" },
  javascript: { roof: "#fcd34d", left: "#d97706", right: "#78350f", accent: "#fef3c7" },
  rust: { roof: "#fdba74", left: "#ea580c", right: "#7c2d12", accent: "#ffedd5" },
  go: { roof: "#67e8f9", left: "#06b6d4", right: "#155e75", accent: "#cffafe" },
  other: { roof: "#cbd5e1", left: "#64748b", right: "#334155", accent: "#f1f5f9" },
};

export function buildingPalette(file: FileMetric, dataMap: DataMapMode): ShadePalette {
  if (dataMap === "living") {
    return ARCHETYPE_PALETTES[file.building_archetype] ?? ARCHETYPE_PALETTES.office_tower;
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
    return { roof: "#64748b", left: "#475569", right: "#1e293b", accent: "#94a3b8" };
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

export function vehicleColor(
  type: "request_car" | "cycle_car" | "sweeper" | "fire_truck" | "crew" | "cargo_ship",
  jammed = false,
  flashPhase = false,
): string {
  if (jammed) return "#ef4444";
  if (type === "fire_truck") return flashPhase ? "#fef08a" : "#f43f5e";
  if (type === "sweeper") return "#4ade80";
  if (type === "crew") return "#fb923c";
  if (type === "cycle_car") return "#e879f9";
  if (type === "cargo_ship") return "#fbbf24";
  return "#38bdf8";
}

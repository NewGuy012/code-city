import type { BuildingArchetype, DataMapMode, FileMetric } from "../types/city";

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

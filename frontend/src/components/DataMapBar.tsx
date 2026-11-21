import {
  Award,
  Box,
  Building2,
  CloudRain,
  Code2,
  Compass,
  Flame,
  Layers,
  Sparkles,
  Users,
} from "lucide-react";

import type { DataMapMode } from "../types/city";

interface DataMapBarProps {
  dataMap: DataMapMode;
  onChangeDataMap: (mode: DataMapMode) => void;
  viewMode: "2d" | "3d";
  onToggleViewMode: () => void;
  onStartTour: () => void;
  onOpenHealthModal: () => void;
  tourActive: boolean;
}

const DATA_MAPS: Array<{
  id: DataMapMode;
  label: string;
  icon: typeof Building2;
  accent: string;
}> = [
  { id: "living", label: "Living City", icon: Building2, accent: "text-amber-300" },
  { id: "hotspots", label: "Construction", icon: Flame, accent: "text-orange-400" },
  { id: "pollution", label: "Smog & Lint", icon: CloudRain, accent: "text-purple-400" },
  { id: "bus_factor", label: "Bus Factor", icon: Users, accent: "text-rose-400" },
  { id: "languages", label: "Languages", icon: Code2, accent: "text-sky-400" },
  { id: "format_drift", label: "Format Drift", icon: Sparkles, accent: "text-fuchsia-400" },
];

export function DataMapBar({
  dataMap,
  onChangeDataMap,
  viewMode,
  onToggleViewMode,
  onStartTour,
  onOpenHealthModal,
  tourActive,
}: DataMapBarProps) {
  return (
    <div className="sim-panel flex flex-wrap items-center gap-1.5 rounded-2xl px-2.5 py-1.5">
      <div className="flex items-center gap-1 pr-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        <Layers className="h-3.5 w-3.5 text-amber-400" />
        <span className="hidden sm:inline">Data Maps</span>
      </div>

      {DATA_MAPS.map((item) => {
        const Icon = item.icon;
        const active = dataMap === item.id;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`datamap-${item.id}`}
            onClick={() => onChangeDataMap(item.id)}
            className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium transition ${
              active
                ? "bg-slate-800 text-white ring-1 ring-amber-400/60"
                : "text-slate-300 hover:bg-slate-800/70 hover:text-white"
            }`}
          >
            <Icon className={`h-3.5 w-3.5 ${active ? item.accent : "text-slate-400"}`} />
            <span>{item.label}</span>
          </button>
        );
      })}

      <div className="mx-1 h-5 w-px bg-slate-700/80" />

      <button
        type="button"
        data-testid="toggle-2d-3d"
        onClick={onToggleViewMode}
        className="flex items-center gap-1.5 rounded-xl bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-300 ring-1 ring-sky-400/35 transition hover:bg-sky-500/25"
      >
        <Box className="h-3.5 w-3.5" />
        <span>{viewMode === "2d" ? "2D ↔ 3D" : "3D ↔ 2D"}</span>
      </button>

      <button
        type="button"
        data-testid="start-tour-btn"
        onClick={onStartTour}
        className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
          tourActive
            ? "bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/60"
            : "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25"
        }`}
      >
        <Compass className="h-3.5 w-3.5" />
        <span>Mayor&apos;s Tour</span>
      </button>

      <button
        type="button"
        data-testid="open-health-btn"
        onClick={onOpenHealthModal}
        className="flex items-center gap-1.5 rounded-xl bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-300 ring-1 ring-amber-400/35 transition hover:bg-amber-500/25"
      >
        <Award className="h-3.5 w-3.5" />
        <span>City Report</span>
      </button>
    </div>
  );
}

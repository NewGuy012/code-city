import type { FileMetric } from "../types/city";
import { cameraStore } from "./cameraStore";

interface BuildingTooltipProps {
  file: FileMetric;
  x: number;
  y: number;
  containerWidth?: number;
}

export function BuildingTooltip({ file, x, y, containerWidth = 1280 }: BuildingTooltipProps) {
  return (
    <div
      data-testid="building-tooltip"
      className="sim-popover pointer-events-none absolute z-20 max-w-xs rounded-xl px-3 py-2 text-xs"
      style={{
        left: Math.max(12, Math.min(containerWidth - 260, x + 14)),
        top: Math.max(12, y - 68),
      }}
    >
      <div className="truncate font-mono font-semibold text-amber-300">{file.file_path}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-slate-300">
        <span className="rounded bg-white/[0.08] px-1.5 py-0.5 capitalize">
          {file.building_archetype.replace(/_/g, " ")}
        </span>
        <span>{file.sloc} SLOC</span>
        <span>Cx {file.max_complexity}</span>
        <span>Hotspot {file.hotspot_score.toFixed(1)}</span>
      </div>
      {(file.lint_issue_count > 0 ||
        file.condition_flags?.crane ||
        file.condition_flags?.lone_keeper) && (
        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
          {file.condition_flags?.crane && <span className="text-amber-400">🏗️ Active Churn</span>}
          {file.lint_issue_count > 0 && (
            <span className="text-purple-300">🌫️ {file.lint_issue_count} lints</span>
          )}
          {file.condition_flags?.lone_keeper && (
            <span className="text-rose-400">🚨 Bus Factor 1</span>
          )}
        </div>
      )}
      <div className="mt-1 text-[10px] text-slate-400">
        Heading {cameraStore.getCompassLabel()} · Pitch {Math.round(cameraStore.getState().pitch)}°
      </div>
    </div>
  );
}

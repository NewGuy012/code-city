import {
  Building2,
  ChevronDown,
  CloudRain,
  Code2,
  Flame,
  Layers,
  Sparkles,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { DataMapMode } from "../types/city";

interface DataMapBarProps {
  dataMap: DataMapMode;
  onChangeDataMap: (mode: DataMapMode) => void;
  isPopoverOpen: boolean;
  onTogglePopover: () => void;
  onClosePopover: () => void;
}

const DATA_MAPS: Array<{
  id: DataMapMode;
  label: string;
  hint: string;
  icon: typeof Building2;
  accent: string;
}> = [
  {
    id: "living",
    label: "Living City",
    hint: "Building archetypes & active city life",
    icon: Building2,
    accent: "text-amber-300",
  },
  {
    id: "hotspots",
    label: "Construction",
    hint: "Churn × Complexity hotspots",
    icon: Flame,
    accent: "text-orange-400",
  },
  {
    id: "pollution",
    label: "Smog & Lint",
    hint: "Lint issues & formatting smog",
    icon: CloudRain,
    accent: "text-purple-400",
  },
  {
    id: "bus_factor",
    label: "Bus Factor",
    hint: "Single-maintainer knowledge risk",
    icon: Users,
    accent: "text-rose-400",
  },
  {
    id: "languages",
    label: "Languages",
    hint: "Polyglot language zoning",
    icon: Code2,
    accent: "text-sky-400",
  },
  {
    id: "format_drift",
    label: "Format Drift",
    hint: "Unformatted or drifting modules",
    icon: Sparkles,
    accent: "text-fuchsia-400",
  },
];

export function DataMapBar({
  dataMap,
  onChangeDataMap,
  isPopoverOpen,
  onTogglePopover,
  onClosePopover,
}: DataMapBarProps) {
  const [isWide, setIsWide] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : true,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsWide(e.matches);
    setIsWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const current = DATA_MAPS.find((m) => m.id === dataMap) ?? DATA_MAPS[0];
  const CurrentIcon = current.icon;

  if (!isWide) {
    return (
      <div data-popover-id="datamap" className="pointer-events-auto relative">
        <button
          type="button"
          data-testid="datamap-dropdown-btn"
          onClick={onTogglePopover}
          title="Switch city data map lens"
          className="sim-panel flex h-10 items-center gap-2 rounded-xl px-3 text-xs font-medium text-white transition hover:bg-white/[0.06]"
        >
          <Layers className="h-3.5 w-3.5 text-slate-400" />
          <CurrentIcon className={`h-3.5 w-3.5 ${current.accent}`} />
          <span>{current.label}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
              isPopoverOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {isPopoverOpen && (
          <div className="sim-popover absolute top-full left-1/2 z-40 mt-2 grid w-72 -translate-x-1/2 grid-cols-2 gap-1.5 rounded-2xl p-2 text-xs">
            {DATA_MAPS.map((item) => {
              const Icon = item.icon;
              const active = dataMap === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`datamap-${item.id}`}
                  onClick={() => {
                    onChangeDataMap(item.id);
                    onClosePopover();
                  }}
                  title={item.hint}
                  className={`flex items-center gap-2 rounded-xl px-2.5 py-2 text-left transition ${
                    active
                      ? "bg-white/[0.12] text-white ring-1 ring-white/15"
                      : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  <Icon
                    className={`h-3.5 w-3.5 shrink-0 ${active ? item.accent : "text-slate-400"}`}
                  />
                  <span className="truncate font-medium">{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="datamap-bar"
      className="sim-panel pointer-events-auto flex h-10 items-center gap-0.5 rounded-xl p-1"
    >
      {DATA_MAPS.map((item) => {
        const Icon = item.icon;
        const active = dataMap === item.id;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`datamap-${item.id}`}
            onClick={() => onChangeDataMap(item.id)}
            title={`${item.label} — ${item.hint}`}
            aria-label={item.label}
            className={`flex h-8 items-center gap-1.5 rounded-lg text-xs font-medium transition ${
              active
                ? "bg-white/[0.11] px-2.5 text-white ring-1 ring-white/15"
                : "w-8 justify-center text-slate-400 hover:bg-white/[0.07] hover:text-slate-100"
            }`}
          >
            <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? item.accent : ""}`} />
            {active && <span className="whitespace-nowrap">{item.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

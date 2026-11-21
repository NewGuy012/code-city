import { ChevronLeft, ChevronRight, Compass, Pause, Play, X } from "lucide-react";

import type { TourLandmark } from "../data/cityDataClient";

interface OnboardingTourProps {
  stops: TourLandmark[];
  stepIndex: number;
  autoPlaying: boolean;
  onSelectStep: (idx: number) => void;
  onToggleAuto: () => void;
  onClose: () => void;
  className?: string;
}

export function OnboardingTour({
  stops,
  stepIndex,
  autoPlaying,
  onSelectStep,
  onToggleAuto,
  onClose,
  className = "",
}: OnboardingTourProps) {
  if (stops.length === 0) return null;
  const stop = stops[stepIndex] ?? stops[0];

  return (
    <div
      data-testid="onboarding-tour"
      className={`sim-popover pointer-events-auto w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl p-3.5 sm:w-96 ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/35">
            <Compass className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
              Mayor&apos;s Guided Tour · Stop {stop.step}/{stops.length}
            </div>
            <h3 className="text-sm font-bold text-white">{stop.title}</h3>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-white"
          title="Exit tour"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="mt-1.5 text-[11px] text-slate-400">{stop.subtitle}</p>
      <p className="mt-1.5 rounded-xl bg-white/[0.04] p-2.5 text-xs leading-relaxed text-slate-200">
        {stop.narration}
      </p>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {stops.map((s, idx) => (
            <button
              key={s.file_path}
              type="button"
              onClick={() => onSelectStep(idx)}
              className={`h-1.5 rounded-full transition ${
                idx === stepIndex ? "w-5 bg-emerald-400" : "w-1.5 bg-white/20 hover:bg-white/40"
              }`}
              title={s.title}
            />
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleAuto}
            className="flex items-center gap-1 rounded-lg bg-white/[0.07] px-2 py-1 text-[11px] text-slate-200 hover:bg-white/[0.12]"
          >
            {autoPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            <span>{autoPlaying ? "Hold" : "Auto"}</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectStep((stepIndex - 1 + stops.length) % stops.length)}
            className="rounded-lg bg-white/[0.07] p-1.5 text-slate-300 hover:bg-white/[0.12]"
            title="Previous stop"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onSelectStep((stepIndex + 1) % stops.length)}
            className="rounded-lg bg-emerald-500 p-1.5 text-slate-950 hover:bg-emerald-400"
            title="Next stop"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

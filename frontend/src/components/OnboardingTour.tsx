import { ChevronLeft, ChevronRight, Compass, Pause, Play, X } from "lucide-react";

import type { TourLandmark } from "../data/cityDataClient";

interface OnboardingTourProps {
  stops: TourLandmark[];
  stepIndex: number;
  autoPlaying: boolean;
  onSelectStep: (idx: number) => void;
  onToggleAuto: () => void;
  onClose: () => void;
}

export function OnboardingTour({
  stops,
  stepIndex,
  autoPlaying,
  onSelectStep,
  onToggleAuto,
  onClose,
}: OnboardingTourProps) {
  if (stops.length === 0) return null;
  const stop = stops[stepIndex] ?? stops[0];

  return (
    <div
      data-testid="onboarding-tour"
      className="sim-panel pointer-events-auto absolute bottom-32 left-4 z-30 w-80 rounded-2xl p-4 sm:w-96"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40">
            <Compass className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
              Mayor&apos;s Guided Tour · Stop {stop.step}/{stops.length}
            </div>
            <h3 className="text-sm font-bold text-white">{stop.title}</h3>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          title="Exit tour"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-400">{stop.subtitle}</p>
      <p className="mt-1.5 rounded-xl bg-slate-900/90 p-2.5 text-xs leading-relaxed text-slate-200">
        {stop.narration}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {stops.map((s, idx) => (
            <button
              key={s.file_path}
              type="button"
              onClick={() => onSelectStep(idx)}
              className={`h-2 rounded-full transition ${
                idx === stepIndex ? "w-5 bg-emerald-400" : "w-2 bg-slate-700 hover:bg-slate-500"
              }`}
              title={s.title}
            />
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleAuto}
            className="flex items-center gap-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
          >
            {autoPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            <span>{autoPlaying ? "Hold" : "Auto"}</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectStep((stepIndex - 1 + stops.length) % stops.length)}
            className="rounded-lg bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700"
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

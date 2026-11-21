import { Flame, Pause, Play, Smile, Sparkles, Users, Volume2, VolumeX, Zap } from "lucide-react";

import type { SimSpeed, SimStateSnapshot } from "../game/simEngine";

interface EconomyBarProps {
  simState: SimStateSnapshot;
  activeQuestCount: number;
  soundEnabled: boolean;
  onChangeSpeed: (speed: SimSpeed) => void;
  onOpenAdvisors: () => void;
  onOpenDisasters: () => void;
  onToggleSound: () => void;
}

export function EconomyBar({
  simState,
  activeQuestCount,
  soundEnabled,
  onChangeSpeed,
  onOpenAdvisors,
  onOpenDisasters,
  onToggleSound,
}: EconomyBarProps) {
  const netPerSprint = simState.incomePerSprint - simState.upkeepPerSprint;

  return (
    <div
      data-testid="economy-bar"
      className="sim-panel pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl px-3 py-1.5 text-xs"
    >
      {/* City Milestone Tier */}
      <div className="flex items-center gap-1.5 pr-1">
        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-semibold text-amber-200">{simState.cityLevel}</span>
      </div>

      <div className="h-4 w-px bg-slate-700" />

      {/* Sprint Clock & Speed (Pause / 1x / 2x / 3x) */}
      <div className="flex items-center gap-1.5">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] font-bold text-sky-300">
            Sprint #{simState.sprintNumber}
          </span>
          <div className="h-1 w-14 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-sky-400 transition-all"
              style={{ width: `${Math.round(simState.sprintProgress * 100)}%` }}
            />
          </div>
        </div>

        <div className="flex items-center rounded-lg bg-slate-900/90 p-0.5 ring-1 ring-slate-700/70">
          {([0, 1, 2, 3] as SimSpeed[]).map((spd) => {
            const active = simState.speed === spd;
            return (
              <button
                key={spd}
                type="button"
                data-testid={`sim-speed-${spd}`}
                onClick={() => onChangeSpeed(spd)}
                title={spd === 0 ? "Pause simulation" : `Run simulation at ${spd}x`}
                className={`flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold transition ${
                  active
                    ? spd === 0
                      ? "bg-rose-500/30 text-rose-200"
                      : "bg-amber-500 text-slate-950"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {spd === 0 ? (
                  <Pause className="h-2.5 w-2.5" />
                ) : (
                  <>
                    {spd === 1 && <Play className="h-2.5 w-2.5" />}
                    <span>{spd}x</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="h-4 w-px bg-slate-700" />

      {/* Sprint Velocity Treasury vs Tech-Debt Upkeep */}
      <div
        className="flex items-center gap-1.5"
        title={`Sprint Income +${simState.incomePerSprint} vs Tech-Debt Upkeep -${simState.upkeepPerSprint}`}
      >
        <Zap className="h-3.5 w-3.5 text-amber-400" />
        <span data-testid="velocity-treasury" className="font-mono font-bold text-white">
          {simState.velocityTreasury}
        </span>
        <span
          className={`font-mono text-[10px] ${
            netPerSprint >= 0 ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          ({netPerSprint >= 0 ? `+${netPerSprint}` : netPerSprint}/sp)
        </span>
      </div>

      {/* Developer Happiness Meter */}
      <div className="flex items-center gap-1.5" title="Developer Happiness %">
        <Smile
          className={`h-3.5 w-3.5 ${
            simState.happiness >= 75
              ? "text-emerald-400"
              : simState.happiness >= 55
                ? "text-amber-400"
                : "text-rose-400"
          }`}
        />
        <span data-testid="happiness-meter" className="font-mono font-bold text-slate-100">
          {simState.happiness}%
        </span>
      </div>

      <div className="h-4 w-px bg-slate-700" />

      {/* City Advisors Council */}
      <button
        type="button"
        data-testid="open-advisors-btn"
        onClick={onOpenAdvisors}
        className="flex items-center gap-1 rounded-xl bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 ring-1 ring-sky-400/35 hover:bg-sky-500/25"
      >
        <Users className="h-3.5 w-3.5 text-sky-400" />
        <span>Advisors</span>
        {activeQuestCount > 0 && (
          <span className="rounded-full bg-amber-400 px-1.5 text-[9px] font-bold text-slate-950">
            {activeQuestCount}
          </span>
        )}
      </button>

      {/* Chaos Disasters Menu */}
      <button
        type="button"
        data-testid="open-disasters-btn"
        onClick={onOpenDisasters}
        className="flex items-center gap-1 rounded-xl bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-200 ring-1 ring-rose-400/35 hover:bg-rose-500/25"
      >
        <Flame className="h-3.5 w-3.5 text-rose-400" />
        <span>Disasters</span>
      </button>

      {/* Sound SFX Toggle */}
      <button
        type="button"
        data-testid="toggle-sound-btn"
        onClick={onToggleSound}
        title={soundEnabled ? "Mute city audio SFX" : "Enable city audio SFX"}
        className={`rounded-lg p-1 transition ${
          soundEnabled ? "text-emerald-300 hover:bg-slate-800" : "text-slate-500 hover:bg-slate-800"
        }`}
      >
        {soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

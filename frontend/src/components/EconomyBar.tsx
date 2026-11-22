import {
  Award,
  Compass,
  Crosshair,
  EyeOff,
  Flame,
  Map,
  MoreHorizontal,
  Pause,
  Play,
  Smile,
  Users,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";

import type { SimSpeed, SimStateSnapshot } from "../game/simEngine";
import type { AdvisorAlert } from "../types/city";
import { HUD_SHORTCUTS, type HudPopoverId } from "./hudPopover";

interface EconomyBarProps {
  simState: SimStateSnapshot;
  alerts: AdvisorAlert[];
  activeQuestCount: number;
  grade: string;
  soundEnabled: boolean;
  tourActive: boolean;
  radarOpen: boolean;
  openPopover: HudPopoverId;
  onTogglePopover: (id: Exclude<HudPopoverId, null>) => void;
  onClosePopover: () => void;
  onChangeSpeed: (speed: SimSpeed) => void;
  onOpenAdvisors: () => void;
  onOpenDisasters: () => void;
  onFocusFile: (filePath: string) => void;
  onOpenHealthModal: () => void;
  onStartTour: () => void;
  onToggleSound: () => void;
  onToggleRadar: () => void;
  onToggleZenMode: () => void;
}

export function EconomyBar({
  simState,
  alerts,
  activeQuestCount,
  grade,
  soundEnabled,
  tourActive,
  radarOpen,
  openPopover,
  onTogglePopover,
  onClosePopover,
  onChangeSpeed,
  onOpenAdvisors,
  onOpenDisasters,
  onFocusFile,
  onOpenHealthModal,
  onStartTour,
  onToggleSound,
  onToggleRadar,
  onToggleZenMode,
}: EconomyBarProps) {
  const netPerSprint = simState.incomePerSprint - simState.upkeepPerSprint;
  const hasActiveDisaster = Boolean(simState.activeDisaster && !simState.activeDisaster.resolved);
  const advisorsOpen = openPopover === "advisors";
  const utilitiesOpen = openPopover === "utilities";

  return (
    <div
      data-testid="economy-bar"
      className={`sim-panel pointer-events-auto relative flex h-10 max-w-full min-w-0 items-center gap-2 rounded-xl px-2.5 text-xs ${
        advisorsOpen || utilitiesOpen ? "z-40" : ""
      }`}
    >
      {/* Sprint Progress & Speed Stepper */}
      <div className="flex items-center gap-2">
        <div
          className="flex flex-col gap-0.5"
          title={`${simState.cityLevel} · Sprint #${simState.sprintNumber}`}
        >
          <span className="sim-pixel-badge font-mono text-[10px] font-semibold text-slate-300">
            S{simState.sprintNumber}
          </span>
          <div className="h-[3px] w-8 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-sky-400/90 transition-all"
              style={{ width: `${Math.round(simState.sprintProgress * 100)}%` }}
            />
          </div>
        </div>

        <div className="flex items-center rounded-lg bg-slate-950/60 p-0.5 ring-1 ring-white/10">
          {([0, 1, 2, 3] as SimSpeed[]).map((spd) => {
            const active = simState.speed === spd;
            return (
              <button
                key={spd}
                type="button"
                data-testid={`sim-speed-${spd}`}
                onClick={() => onChangeSpeed(spd)}
                title={spd === 0 ? "Pause simulation" : `Run simulation at ${spd}x`}
                className={`flex h-6 items-center gap-0.5 rounded-md px-1.5 font-mono text-[10px] font-bold transition ${
                  active
                    ? spd === 0
                      ? "bg-rose-500/25 text-rose-200"
                      : "bg-amber-400 text-slate-950"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {spd === 0 ? (
                  <Pause className="h-2.5 w-2.5" />
                ) : (
                  <>
                    {spd === 1 && <Play className="h-2.5 w-2.5" />}
                    <span>{spd}×</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Velocity Treasury & Happiness */}
      <div className="hidden items-center gap-2.5 sm:flex">
        <div
          className="flex items-center gap-1"
          title={`Velocity ${simState.velocityTreasury} (${netPerSprint >= 0 ? `+${netPerSprint}` : netPerSprint}/sprint: +${simState.incomePerSprint} income, -${simState.upkeepPerSprint} upkeep)`}
        >
          <Zap className="h-3.5 w-3.5 text-amber-400" />
          <span
            data-testid="velocity-treasury"
            className="sim-pixel-badge font-mono text-[11px] font-bold text-slate-100"
          >
            {simState.velocityTreasury}
          </span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              netPerSprint >= 0 ? "bg-emerald-400/80" : "bg-rose-400/90"
            }`}
          />
        </div>

        <div
          className="flex items-center gap-1"
          title={`Developer Happiness: ${simState.happiness}%`}
        >
          <Smile
            className={`h-3.5 w-3.5 ${
              simState.happiness >= 75
                ? "text-emerald-400"
                : simState.happiness >= 55
                  ? "text-slate-300"
                  : "text-rose-400"
            }`}
          />
          <span
            data-testid="happiness-meter"
            className="sim-pixel-badge font-mono text-[11px] font-semibold text-slate-200"
          >
            {simState.happiness}%
          </span>
        </div>
      </div>

      <div className="h-4 w-px bg-white/10" />

      {/* Advisors Quick-Peek Popover */}
      <div data-popover-id="advisors" className="relative">
        <button
          type="button"
          data-testid="advisors-menu-btn"
          onClick={() => onTogglePopover("advisors")}
          title="Advisor Alerts & SQL Quests"
          className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
            advisorsOpen
              ? "bg-white/[0.12] text-white ring-1 ring-white/15"
              : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
          }`}
        >
          <Users className="h-3.5 w-3.5 text-sky-300" />
          {activeQuestCount > 0 && (
            <span className="sim-pixel-badge rounded-full bg-amber-400/90 px-1.5 py-px font-mono text-[10px] font-bold text-slate-950">
              {activeQuestCount}
            </span>
          )}
        </button>

        {advisorsOpen && (
          <div
            data-testid="advisors-popover"
            className="sim-popover sim-scrollbar absolute top-full right-0 z-40 mt-2 max-h-[calc(var(--hud-vh,100vh)-5rem)] w-[min(20rem,calc(var(--hud-vw,100vw)-1.5rem))] overflow-y-auto rounded-2xl p-3 text-xs"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                City Advisor Feed
              </span>
              <button
                type="button"
                data-testid="open-advisors-btn"
                onClick={() => {
                  onClosePopover();
                  onOpenAdvisors();
                }}
                className="rounded-lg bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-300 ring-1 ring-sky-400/30 transition hover:bg-sky-500/25"
              >
                SQL Quests ({activeQuestCount})
              </button>
            </div>

            {alerts.length > 0 ? (
              <div className="sim-scrollbar max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
                {alerts.map((alert, i) => {
                  const dotTone =
                    alert.severity === "critical"
                      ? "bg-rose-400"
                      : alert.severity === "warn"
                        ? "bg-amber-400"
                        : "bg-sky-400";
                  return (
                    <button
                      key={`${alert.title}-${i}`}
                      type="button"
                      disabled={!alert.target_path}
                      onClick={() => {
                        if (alert.target_path) {
                          onFocusFile(alert.target_path);
                          onClosePopover();
                        }
                      }}
                      className="group flex w-full items-start gap-2 rounded-xl bg-white/[0.04] p-2 text-left transition hover:bg-white/[0.08] disabled:cursor-default disabled:hover:bg-white/[0.04]"
                    >
                      <span className="mt-0.5 text-sm leading-none">{alert.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotTone}`} />
                          <span className="truncate font-semibold text-slate-100">
                            {alert.title}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-400">
                          {alert.detail}
                        </p>
                      </div>
                      {alert.target_path && (
                        <Crosshair className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 opacity-0 transition group-hover:text-sky-300 group-hover:opacity-100" />
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-xl bg-white/[0.03] px-3 py-2.5 text-[11px] text-slate-400">
                All districts nominal — no active advisor alerts.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Disasters Modal Trigger */}
      <button
        type="button"
        data-testid="open-disasters-btn"
        onClick={onOpenDisasters}
        title="Chaos Disasters & Resilience Drills"
        aria-label="Disasters"
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${
          hasActiveDisaster
            ? "animate-pulse bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/50"
            : "text-slate-300 hover:bg-white/[0.07] hover:text-rose-300"
        }`}
      >
        <Flame className="h-3.5 w-3.5" />
      </button>

      {/* Utilities & Overflow Menu */}
      <div data-popover-id="utilities" className="relative">
        <button
          type="button"
          data-testid="utilities-menu-btn"
          onClick={() => onTogglePopover("utilities")}
          title="City Report, Tour, Audio, Shortcuts & Zen Mode"
          aria-label="More options"
          className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${
            utilitiesOpen
              ? "bg-white/[0.12] text-white ring-1 ring-white/15"
              : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
          }`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {utilitiesOpen && (
          <div
            data-testid="utilities-popover"
            className="sim-popover sim-scrollbar absolute top-full right-0 z-40 mt-2 max-h-[calc(var(--hud-vh,100vh)-5rem)] w-[min(16rem,calc(var(--hud-vw,100vw)-1.5rem))] overflow-y-auto rounded-2xl p-2 text-xs"
          >
            <button
              type="button"
              data-testid="open-health-btn"
              onClick={() => {
                onClosePopover();
                onOpenHealthModal();
              }}
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.07] hover:text-white"
            >
              <span className="flex items-center gap-2">
                <Award className="h-3.5 w-3.5 text-amber-300" />
                <span>City Report &amp; Export</span>
              </span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                {grade}
              </span>
            </button>

            <button
              type="button"
              data-testid="start-tour-btn"
              onClick={() => {
                onClosePopover();
                onStartTour();
              }}
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.07] hover:text-white"
            >
              <span className="flex items-center gap-2">
                <Compass className="h-3.5 w-3.5 text-emerald-300" />
                <span>Mayor&apos;s Guided Tour</span>
              </span>
              {tourActive && (
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                  Active
                </span>
              )}
            </button>

            <button
              type="button"
              data-testid="toggle-sound-btn"
              onClick={onToggleSound}
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.07] hover:text-white"
            >
              <span className="flex items-center gap-2">
                {soundEnabled ? (
                  <Volume2 className="h-3.5 w-3.5 text-emerald-300" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                )}
                <span>City Audio SFX</span>
              </span>
              <span className="text-[11px] text-slate-400">{soundEnabled ? "On" : "Muted"}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                onClosePopover();
                onToggleRadar();
              }}
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.07] hover:text-white"
            >
              <span className="flex items-center gap-2">
                <Map className="h-3.5 w-3.5 text-sky-300" />
                <span>{radarOpen ? "Hide Radar" : "Show Radar"}</span>
              </span>
              <kbd className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                M
              </kbd>
            </button>

            <button
              type="button"
              data-testid="toggle-zen-btn"
              onClick={() => {
                onClosePopover();
                onToggleZenMode();
              }}
              className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.07] hover:text-white"
            >
              <span className="flex items-center gap-2">
                <EyeOff className="h-3.5 w-3.5 text-slate-300" />
                <span>Zen Mode (Hide UI)</span>
              </span>
              <kbd className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                H
              </kbd>
            </button>

            <div className="mt-1.5 border-t border-white/10 px-2 pt-2 pb-1">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Shortcuts
              </div>
              <div className="space-y-1">
                {HUD_SHORTCUTS.map((s) => (
                  <div key={s.keys} className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-400">{s.label}</span>
                    <kbd className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-slate-300">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

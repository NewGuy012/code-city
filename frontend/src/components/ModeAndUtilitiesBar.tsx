import {
  Award,
  Compass,
  EyeOff,
  Gamepad2,
  Map,
  MoreHorizontal,
  Volume2,
  VolumeX,
} from "lucide-react";

import { HUD_SHORTCUTS, type HudPopoverId } from "./hudPopover";

export type AppMode = "explore" | "play";

interface ModeAndUtilitiesBarProps {
  appMode: AppMode;
  onChangeAppMode: (mode: AppMode) => void;
  grade: string;
  soundEnabled: boolean;
  tourActive: boolean;
  radarOpen: boolean;
  openPopover: HudPopoverId;
  onTogglePopover: (id: Exclude<HudPopoverId, null>) => void;
  onClosePopover: () => void;
  onOpenHealthModal: () => void;
  onStartTour: () => void;
  onToggleSound: () => void;
  onToggleRadar: () => void;
  onToggleZenMode: () => void;
}

const MODE_OPTIONS: Array<{
  id: AppMode;
  label: string;
  hint: string;
  icon: typeof Compass;
  activeClass: string;
}> = [
  {
    id: "explore",
    label: "Explore",
    hint: "Explore Mode — inspect architecture, data maps & Git history",
    icon: Compass,
    activeClass: "bg-sky-500/25 text-sky-200 ring-1 ring-sky-400/35",
  },
  {
    id: "play",
    label: "Play",
    hint: "Game Play Mode — simulation clock, Velocity economy, Mayor tools & disasters",
    icon: Gamepad2,
    activeClass: "bg-amber-400 text-slate-950",
  },
];

export function ModeAndUtilitiesBar({
  appMode,
  onChangeAppMode,
  grade,
  soundEnabled,
  tourActive,
  radarOpen,
  openPopover,
  onTogglePopover,
  onClosePopover,
  onOpenHealthModal,
  onStartTour,
  onToggleSound,
  onToggleRadar,
  onToggleZenMode,
}: ModeAndUtilitiesBarProps) {
  const utilitiesOpen = openPopover === "utilities";

  const utilityItems = [
    {
      testId: "open-health-btn",
      icon: <Award className="h-3.5 w-3.5 text-amber-300" />,
      label: "City Report & Export",
      right: (
        <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-300">
          {grade}
        </span>
      ),
      onClick: () => {
        onClosePopover();
        onOpenHealthModal();
      },
    },
    {
      testId: "start-tour-btn",
      icon: <Compass className="h-3.5 w-3.5 text-emerald-300" />,
      label: "Mayor's Guided Tour",
      right: tourActive ? (
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
          Active
        </span>
      ) : null,
      onClick: () => {
        onClosePopover();
        onStartTour();
      },
    },
    {
      testId: "toggle-sound-btn",
      icon: soundEnabled ? (
        <Volume2 className="h-3.5 w-3.5 text-emerald-300" />
      ) : (
        <VolumeX className="h-3.5 w-3.5 text-slate-400" />
      ),
      label: "City Audio SFX",
      right: <span className="text-[11px] text-slate-400">{soundEnabled ? "On" : "Muted"}</span>,
      onClick: onToggleSound,
    },
    {
      icon: <Map className="h-3.5 w-3.5 text-sky-300" />,
      label: radarOpen ? "Hide Radar" : "Show Radar",
      right: (
        <kbd className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          M
        </kbd>
      ),
      onClick: () => {
        onClosePopover();
        onToggleRadar();
      },
    },
    {
      testId: "toggle-zen-btn",
      icon: <EyeOff className="h-3.5 w-3.5 text-slate-300" />,
      label: "Zen Mode (Hide UI)",
      right: (
        <kbd className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          H
        </kbd>
      ),
      onClick: () => {
        onClosePopover();
        onToggleZenMode();
      },
    },
  ];

  return (
    <div
      data-testid="mode-utilities-bar"
      className={`sim-panel pointer-events-auto relative flex h-10 max-w-full shrink-0 items-center gap-2 rounded-xl px-2 text-xs ${
        utilitiesOpen ? "z-40" : ""
      }`}
    >
      <div
        data-testid="mode-toggle"
        role="group"
        aria-label="Studio mode"
        className="flex h-7 items-center rounded-lg bg-slate-950/60 p-0.5 ring-1 ring-white/10"
      >
        {MODE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const active = appMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              data-testid={`mode-toggle-${opt.id}`}
              aria-pressed={active}
              onClick={() => onChangeAppMode(opt.id)}
              title={opt.hint}
              className={`flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold transition ${
                active ? opt.activeClass : "text-slate-400 hover:text-slate-100"
              }`}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      <div className="h-4 w-px bg-white/10" />

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
            {utilityItems.map((item) => (
              <button
                key={item.label}
                type="button"
                data-testid={item.testId}
                onClick={item.onClick}
                className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.07] hover:text-white"
              >
                <span className="flex items-center gap-2">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
                {item.right}
              </button>
            ))}

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

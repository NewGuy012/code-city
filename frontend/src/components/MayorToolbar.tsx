import {
  Brush,
  Check,
  Copy,
  Download,
  FileText,
  GitBranch,
  Hammer,
  MousePointer,
  Network,
  Redo2,
  RotateCcw,
  Scissors,
  Trees,
  Undo2,
  UserPlus,
} from "lucide-react";
import { useState } from "react";

import type { CitySnapshotBundle } from "../data/cityDataClient";
import {
  type MayorToolId,
  type SandboxActionRecord,
  TOOL_COSTS,
  generateRefactorBlueprintMarkdown,
} from "../game/sandboxOverlay";
import { ModalShell } from "./ModalShell";
import { useCopyFeedback } from "./hudPopover";

interface MayorToolbarProps {
  activeTool: MayorToolId;
  onSelectTool: (tool: MayorToolId) => void;
  actions: SandboxActionRecord[];
  isStaticMode: boolean;
  liveMode: boolean;
  liveBranchName: string | null;
  coopSyncEnabled: boolean;
  repoLabel: string;
  baseBundle: CitySnapshotBundle | null;
  effectiveBundle: CitySnapshotBundle | null;
  pendingTransitStart: string | null;
  isModePopoverOpen: boolean;
  onToggleModePopover: () => void;
  onClosePopover: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onToggleLiveMode: () => void;
  onToggleCoopSync: () => void;
  className?: string;
}

export const MAYOR_TOOLS: Array<{
  id: MayorToolId;
  label: string;
  desc: string;
  icon: typeof Brush;
  accent: string;
}> = [
  {
    id: "inspect",
    label: "Inspect",
    desc: "Select buildings & inspect blast radius (Esc)",
    icon: MousePointer,
    accent: "text-slate-100",
  },
  {
    id: "sweeper",
    label: "Sweeper",
    desc: "Clear lint smog & format drift (drag-paint or click)",
    icon: Brush,
    accent: "text-emerald-300",
  },
  {
    id: "splitter",
    label: "Split Tower",
    desc: "Split monolith (SLOC > 400 or Cx > 15) into balanced towers",
    icon: Scissors,
    accent: "text-amber-300",
  },
  {
    id: "transit_hub",
    label: "Transit Hub",
    desc: "Insert Interface Hub to break circular jams & fault lines",
    icon: Network,
    accent: "text-sky-300",
  },
  {
    id: "proving_park",
    label: "Proving Park",
    desc: "Plant Greenbelt test park (+Happiness, Disaster shield)",
    icon: Trees,
    accent: "text-green-400",
  },
  {
    id: "co_maintainer",
    label: "Co-Maintain",
    desc: "Assign co-maintainer to Bus Factor = 1 hub",
    icon: UserPlus,
    accent: "text-teal-300",
  },
  {
    id: "bulldozer",
    label: "Bulldozer",
    desc: "Demolish dead module (fan-in == 0, non-entrypoint)",
    icon: Hammer,
    accent: "text-rose-400",
  },
];

export function MayorToolbar({
  activeTool,
  onSelectTool,
  actions,
  isStaticMode,
  liveMode,
  liveBranchName,
  coopSyncEnabled,
  repoLabel,
  baseBundle,
  effectiveBundle,
  pendingTransitStart,
  isModePopoverOpen,
  onToggleModePopover,
  onClosePopover,
  onUndo,
  onRedo,
  onReset,
  onToggleLiveMode,
  onToggleCoopSync,
  className = "absolute top-1/2 left-3 z-20 -translate-y-1/2",
}: MayorToolbarProps) {
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [copied, copyBlueprint] = useCopyFeedback();

  const canUndo = actions.some((a) => a.active);
  const canRedo = actions.some((a) => !a.active);
  const activeCount = actions.filter((a) => a.active).length;

  const blueprintMd =
    baseBundle && effectiveBundle
      ? generateRefactorBlueprintMarkdown(repoLabel, actions, baseBundle, effectiveBundle)
      : "";

  function handleDownloadBlueprint() {
    const blob = new Blob([blueprintMd], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${repoLabel.replace(/[^a-zA-Z0-9._-]+/g, "_")}_refactor_blueprint.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <aside
        data-testid="mayor-toolbar"
        className={`sim-panel pointer-events-auto flex max-h-full min-w-11 w-fit flex-col flex-wrap content-start items-center gap-0.5 rounded-2xl p-1.5 text-xs ${
          isModePopoverOpen ? "z-40" : ""
        } ${className}`}
      >
        <div data-popover-id="mayorMode" className="relative">
          <button
            type="button"
            data-testid="mayor-mode-btn"
            onClick={onToggleModePopover}
            title={
              liveMode
                ? `Live Git Mayor Mode (${liveBranchName ?? "branch"})`
                : `Refactor Sandbox Mode${coopSyncEnabled ? " · Co-Op ON" : ""}`
            }
            aria-label="Mayor Execution Mode"
            className={`relative flex h-8 w-8 items-center justify-center rounded-xl transition ${
              liveMode
                ? "bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/50"
                : isModePopoverOpen
                  ? "bg-white/[0.12] text-white ring-1 ring-white/15"
                  : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
            }`}
          >
            <GitBranch className="h-4 w-4" />
            {coopSyncEnabled && !isStaticMode && (
              <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />
            )}
          </button>

          {isModePopoverOpen && (
            <div
              data-testid="mayor-mode-popover"
              className="sim-popover sim-scrollbar absolute top-0 left-full z-40 ml-2.5 max-h-[calc(var(--hud-vh,100vh)-6rem)] w-[min(15rem,calc(var(--hud-vw,100vw)-4.5rem))] overflow-y-auto rounded-2xl p-3 text-xs"
            >
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Execution Mode
              </div>

              <button
                type="button"
                data-testid="toggle-mayor-mode"
                disabled={isStaticMode}
                onClick={() => {
                  onToggleLiveMode();
                  onClosePopover();
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition ${
                  liveMode
                    ? "bg-rose-500/20 text-rose-200 ring-1 ring-rose-400/40"
                    : "bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/30 hover:bg-sky-500/25"
                } disabled:opacity-60`}
              >
                <div>
                  <div className="font-semibold">{liveMode ? "Live Git Mode" : "Sandbox Mode"}</div>
                  <div className="text-[10px] text-slate-400">
                    {isStaticMode
                      ? "Static export runs in Sandbox"
                      : liveMode
                        ? "Commits changes to Mayor branch"
                        : "Safe DuckDB-Wasm overlay"}
                  </div>
                </div>
                <span className="rounded-md bg-slate-950/60 px-1.5 py-0.5 text-[10px] font-semibold">
                  {liveMode ? "LIVE" : "SAFE"}
                </span>
              </button>

              {liveMode && liveBranchName && (
                <div className="mt-1.5 truncate rounded-lg bg-slate-950/70 px-2 py-1 font-mono text-[10px] text-rose-300">
                  {liveBranchName}
                </div>
              )}

              {!isStaticMode && (
                <button
                  type="button"
                  data-testid="toggle-coop-sync"
                  onClick={onToggleCoopSync}
                  className="mt-2 flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-2.5 py-2 text-left text-slate-200 transition hover:bg-white/[0.08]"
                >
                  <div>
                    <div className="font-medium">Co-Op Sync</div>
                    <div className="text-[10px] text-slate-400">Quack + DuckLake live sync</div>
                  </div>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                      coopSyncEnabled
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-white/[0.06] text-slate-400"
                    }`}
                  >
                    {coopSyncEnabled ? "ON" : "OFF"}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="my-0.5 h-px w-6 bg-white/10" />

        {MAYOR_TOOLS.map((t) => {
          const Icon = t.icon;
          const active = activeTool === t.id;
          const cost = t.id === "inspect" ? null : TOOL_COSTS[t.id];
          const waitingSecondClick = t.id === "transit_hub" && Boolean(pendingTransitStart);
          return (
            <div key={t.id} className="group relative">
              <button
                type="button"
                data-testid={`tool-${t.id}`}
                onClick={() => onSelectTool(t.id)}
                aria-label={t.label}
                className={`relative flex h-8 w-8 items-center justify-center rounded-xl transition ${
                  active
                    ? "bg-amber-400/20 text-white ring-1 ring-amber-400/60"
                    : "text-slate-400 hover:bg-white/[0.08] hover:text-slate-100"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? t.accent : ""}`} />
                {waitingSecondClick && (
                  <span className="absolute top-1 right-1 h-1.5 w-1.5 animate-ping rounded-full bg-sky-400" />
                )}
              </button>

              <div className="sim-popover pointer-events-none invisible absolute top-1/2 left-full z-40 ml-2.5 w-52 -translate-y-1/2 rounded-xl px-2.5 py-2 text-left opacity-0 transition-opacity duration-100 group-hover:visible group-hover:opacity-100">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-white">{t.label}</span>
                  {cost !== null && (
                    <span className="font-mono text-[10px] font-bold text-amber-300">
                      -{cost} ⚡
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{t.desc}</p>
              </div>
            </div>
          );
        })}

        {actions.length > 0 && (
          <>
            <div className="my-0.5 h-px w-6 bg-white/10" />
            <button
              type="button"
              data-testid="sandbox-undo-btn"
              disabled={!canUndo}
              onClick={onUndo}
              title="Undo last Mayor action"
              className="flex h-7 w-8 items-center justify-center rounded-lg text-slate-300 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-30"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="sandbox-redo-btn"
              disabled={!canRedo}
              onClick={onRedo}
              title="Redo Mayor action"
              className="flex h-7 w-8 items-center justify-center rounded-lg text-slate-300 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-30"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="sandbox-reset-btn"
              onClick={onReset}
              title="Reset sandbox to HEAD"
              className="flex h-7 w-8 items-center justify-center rounded-lg text-rose-300/80 transition hover:bg-rose-500/15 hover:text-rose-200"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </>
        )}

        <div className="my-0.5 h-px w-6 bg-white/10" />

        <button
          type="button"
          data-testid="export-blueprint-btn"
          onClick={() => setBlueprintOpen(true)}
          title="Export Mayor's Refactor Blueprint (Markdown / GitHub Issues)"
          aria-label="Refactor Blueprint"
          className={`relative flex h-8 w-8 items-center justify-center rounded-xl transition ${
            activeCount > 0
              ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40 hover:bg-amber-500/30"
              : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
          }`}
        >
          <FileText className="h-4 w-4" />
          {activeCount > 0 && (
            <span className="sim-pixel-badge absolute -top-1 -right-1 rounded-full bg-amber-400 px-1 font-mono text-[9px] font-bold leading-tight text-slate-950">
              {activeCount}
            </span>
          )}
        </button>
      </aside>

      <ModalShell
        open={blueprintOpen}
        testId="blueprint-modal"
        title="Mayor's Refactor Blueprint"
        subtitle="Markdown checklist & GitHub Issues plan from Refactor Sandbox"
        icon={<FileText className="h-5 w-5 text-amber-400" />}
        onClose={() => setBlueprintOpen(false)}
        footer={
          <>
            <span />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => copyBlueprint(blueprintMd)}
                className="flex items-center gap-1.5 rounded-xl bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copied ? "Copied!" : "Copy Markdown"}</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadBlueprint}
                className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Download .md</span>
              </button>
            </div>
          </>
        }
      >
        <div className="sim-scrollbar flex-1 overflow-y-auto p-6">
          <pre className="whitespace-pre-wrap rounded-2xl border border-white/10 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
            {blueprintMd}
          </pre>
        </div>
      </ModalShell>
    </>
  );
}

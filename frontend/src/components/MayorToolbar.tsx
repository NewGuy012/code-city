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
  X,
} from "lucide-react";
import { useState } from "react";

import type { CitySnapshotBundle } from "../data/cityDataClient";
import {
  type MayorToolId,
  type SandboxActionRecord,
  TOOL_COSTS,
  generateRefactorBlueprintMarkdown,
} from "../game/sandboxOverlay";

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
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onToggleLiveMode: () => void;
  onToggleCoopSync: () => void;
}

const TOOLS: Array<{
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
    accent: "text-slate-200",
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
    desc: "Split monolith (SLOC > 400 or Cx > 15) into 2-3 balanced towers",
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
  onUndo,
  onRedo,
  onReset,
  onToggleLiveMode,
  onToggleCoopSync,
}: MayorToolbarProps) {
  const [blueprintOpen, setBlueprintOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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
    a.download = `${repoLabel.replace(/\//g, "_")}_refactor_blueprint.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <aside
        data-testid="mayor-toolbar"
        className="sim-panel pointer-events-auto absolute top-32 left-3 z-20 flex flex-col gap-1 rounded-2xl p-1.5 text-xs"
      >
        {/* Sandbox / Live Mayor Mode Pill */}
        <button
          type="button"
          data-testid="toggle-mayor-mode"
          disabled={isStaticMode}
          onClick={onToggleLiveMode}
          title={
            isStaticMode
              ? "Static export runs in Sandbox Mode"
              : "Toggle Refactor Sandbox vs Live Git Branch Mayor Mode"
          }
          className={`flex items-center justify-center gap-1 rounded-xl px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition ${
            liveMode
              ? "bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/50"
              : "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/35"
          } disabled:opacity-70`}
        >
          <GitBranch className="h-3 w-3" />
          <span>{liveMode ? "Live Git" : "Sandbox"}</span>
        </button>

        {liveMode && liveBranchName && (
          <div className="max-w-[96px] truncate rounded-lg bg-slate-900/90 px-1.5 py-0.5 text-center font-mono text-[9px] text-rose-300">
            {liveBranchName}
          </div>
        )}

        {!isStaticMode && (
          <button
            type="button"
            data-testid="toggle-coop-sync"
            onClick={onToggleCoopSync}
            title="Sync Sandbox Actions with teammates via Quack + DuckLake"
            className={`rounded-lg px-2 py-0.5 text-[9px] font-semibold transition ${
              coopSyncEnabled
                ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40"
                : "bg-slate-900/70 text-slate-400 hover:text-slate-200"
            }`}
          >
            {coopSyncEnabled ? "Co-Op: ON" : "Co-Op: OFF"}
          </button>
        )}

        <div className="my-0.5 h-px bg-slate-700/80" />

        {/* 6 Mayor Tools + Inspect */}
        {TOOLS.map((t) => {
          const Icon = t.icon;
          const active = activeTool === t.id;
          const cost = t.id === "inspect" ? null : TOOL_COSTS[t.id];
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`tool-${t.id}`}
              onClick={() => onSelectTool(t.id)}
              title={t.desc}
              className={`group flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left transition ${
                active
                  ? "bg-amber-500/20 text-white ring-1 ring-amber-400/70"
                  : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <Icon className={`h-3.5 w-3.5 ${active ? t.accent : "text-slate-400 group-hover:text-slate-200"}`} />
                <span className="hidden text-[11px] font-medium md:inline">{t.label}</span>
              </span>
              {cost !== null && (
                <span className="hidden font-mono text-[9px] text-amber-300/80 md:inline">
                  {cost}
                </span>
              )}
            </button>
          );
        })}

        {pendingTransitStart && activeTool === "transit_hub" && (
          <div className="max-w-[106px] truncate rounded-lg bg-sky-500/20 px-1.5 py-1 text-[10px] text-sky-200">
            Link: {pendingTransitStart.split("/").pop()} → ?
          </div>
        )}

        <div className="my-0.5 h-px bg-slate-700/80" />

        {/* Undo / Redo / Reset */}
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            data-testid="sandbox-undo-btn"
            disabled={!canUndo}
            onClick={onUndo}
            title="Undo last Mayor action"
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-35"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="sandbox-redo-btn"
            disabled={!canRedo}
            onClick={onRedo}
            title="Redo Mayor action"
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-35"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="sandbox-reset-btn"
            disabled={actions.length === 0}
            onClick={onReset}
            title="Reset sandbox to HEAD"
            className="rounded-lg p-1.5 text-rose-300 hover:bg-slate-800 disabled:opacity-35"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Export Refactor Blueprint */}
        <button
          type="button"
          data-testid="export-blueprint-btn"
          onClick={() => setBlueprintOpen(true)}
          title="Export Mayor's Refactor Blueprint (Markdown / GitHub Issues)"
          className="flex items-center justify-center gap-1 rounded-xl bg-amber-500/20 px-2 py-1.5 text-[11px] font-semibold text-amber-200 ring-1 ring-amber-400/35 hover:bg-amber-500/30"
        >
          <FileText className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Blueprint</span>
          {activeCount > 0 && (
            <span className="rounded-full bg-amber-400 px-1.5 text-[9px] font-bold text-slate-950">
              {activeCount}
            </span>
          )}
        </button>
      </aside>

      {/* Refactor Blueprint Modal */}
      {blueprintOpen && (
        <div
          data-testid="blueprint-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
        >
          <div className="sim-panel flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl">
            <div className="flex items-center justify-between border-b border-slate-700/70 px-6 py-4">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-amber-400" />
                <div>
                  <h2 className="text-base font-bold text-white">
                    Mayor&apos;s Refactor Blueprint
                  </h2>
                  <p className="text-xs text-slate-400">
                    Markdown checklist &amp; GitHub Issues plan from DuckDB-Wasm sandbox_actions
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBlueprintOpen(false)}
                className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <pre className="whitespace-pre-wrap rounded-2xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
                {blueprintMd}
              </pre>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-3">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(blueprintMd);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="flex items-center gap-1.5 rounded-xl bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
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
          </div>
        </div>
      )}
    </>
  );
}

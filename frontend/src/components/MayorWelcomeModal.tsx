import { Building2, Compass, FolderTree, Layers, MapPin, Sparkles } from "lucide-react";

import { sourceBadgeMeta } from "../data/buildingDescription";
import type { CityBriefing } from "../types/city";
import { ModalShell } from "./ModalShell";

interface MayorWelcomeModalProps {
  open: boolean;
  briefing: CityBriefing | null;
  isStaticMode: boolean;
  llmEnabled: boolean;
  llmLoading: boolean;
  onRefreshBriefingWithAi?: () => void;
  onFocusDistrict: (districtPath: string) => void;
  onFocusFile: (filePath: string) => void;
  onStartTour: () => void;
  onClose: () => void;
}

export function MayorWelcomeModal({
  open,
  briefing,
  isStaticMode,
  llmEnabled,
  llmLoading,
  onRefreshBriefingWithAi,
  onFocusDistrict,
  onFocusFile,
  onStartTour,
  onClose,
}: MayorWelcomeModalProps) {
  if (!open || !briefing) return null;

  const badge = sourceBadgeMeta(briefing.source, briefing.model);
  const canUpgradeWithAi =
    !isStaticMode &&
    llmEnabled &&
    briefing.source !== "llamacpp" &&
    briefing.source !== "gemini" &&
    Boolean(onRefreshBriefingWithAi);

  return (
    <ModalShell
      open={open}
      testId="mayor-welcome-modal"
      maxWidthClass="max-w-3xl"
      title={briefing.headline}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <span>High-level codebase onboarding guide</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.toneClass}`}>
            {badge.label}
          </span>
        </span>
      }
      icon={
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/25 to-emerald-400/25 text-amber-300 ring-1 ring-amber-400/40">
          <Building2 className="h-5 w-5" />
        </div>
      }
      closeTitle="Close welcome guide"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            data-testid="welcome-start-tour-btn"
            onClick={() => {
              onClose();
              onStartTour();
            }}
            className="flex items-center gap-1.5 rounded-xl border border-emerald-400/35 bg-emerald-500/15 px-3.5 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25"
          >
            <Compass className="h-3.5 w-3.5" />
            <span>Take Guided Tour</span>
          </button>

          <button
            type="button"
            data-testid="welcome-explore-btn"
            onClick={onClose}
            className="rounded-xl bg-amber-500 px-4 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
          >
            Explore the City
          </button>
        </>
      }
    >
      <div className="sim-scrollbar flex-1 space-y-4 overflow-y-auto px-6 py-4 text-xs">
        <div className="rounded-2xl border border-amber-400/25 bg-gradient-to-br from-amber-500/10 to-slate-900/90 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
              <Sparkles className="h-3.5 w-3.5" />
              <span>A Quick Hello From the Mayor</span>
            </div>
            {canUpgradeWithAi && (
              <button
                type="button"
                onClick={onRefreshBriefingWithAi}
                disabled={llmLoading}
                className="rounded-lg bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-sky-200 transition hover:bg-white/20 disabled:opacity-50"
              >
                {llmLoading ? "Summarizing..." : "Enhance with AI"}
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-100">
            {briefing.mayor_welcome}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-slate-900/85 p-3.5">
            <div className="flex items-center gap-1.5 font-semibold text-sky-300">
              <Layers className="h-3.5 w-3.5" />
              <span>What This Project Does</span>
            </div>
            <p className="mt-1.5 leading-relaxed text-slate-200">{briefing.overview}</p>
          </div>

          <div className="rounded-2xl bg-slate-900/85 p-3.5">
            <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
              <FolderTree className="h-3.5 w-3.5" />
              <span>How the Pieces Fit Together</span>
            </div>
            <p className="mt-1.5 leading-relaxed text-slate-200">{briefing.architecture_summary}</p>
          </div>
        </div>

        {briefing.recommended_starts.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <MapPin className="h-3.5 w-3.5 text-amber-400" />
              <span>Best Places to Start Exploring</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {briefing.recommended_starts.map((start) => (
                <button
                  key={start.file_path}
                  type="button"
                  data-testid="welcome-start-card"
                  onClick={() => {
                    onClose();
                    onFocusFile(start.file_path);
                  }}
                  className="flex flex-col items-start rounded-2xl border border-white/10 bg-slate-900/80 p-3 text-left transition hover:border-amber-400/40 hover:bg-slate-800/80"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="font-semibold text-amber-300">{start.title}</span>
                    <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] capitalize text-slate-300">
                      {start.archetype.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="mt-0.5 max-w-full truncate font-mono text-[11px] text-sky-300">
                    {start.file_path}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-300">
                    {start.reason}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {briefing.district_guides.length > 0 && (
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              City Neighborhoods ({briefing.district_guides.length})
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {briefing.district_guides.map((dist) => (
                <button
                  key={dist.district_path}
                  type="button"
                  onClick={() => {
                    onClose();
                    onFocusDistrict(dist.district_path);
                  }}
                  className="rounded-xl border border-white/[0.07] bg-slate-950/70 px-3 py-2 text-left transition hover:border-sky-400/35 hover:bg-slate-900"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[11px] font-semibold text-white">
                      {dist.district_path}/
                    </span>
                    <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                      {dist.plain_label} · {dist.file_count}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-400">
                    {dist.summary}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-white/[0.06] bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
          <span>🏢 Taller buildings = larger files</span>
          <span>·</span>
          <span>🗺️ Neighborhoods = feature areas</span>
          <span>·</span>
          <span>👆 Click any building = plain-English summary &amp; code</span>
        </div>
      </div>
    </ModalShell>
  );
}

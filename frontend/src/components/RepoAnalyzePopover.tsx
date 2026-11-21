import { Building2, Check, ChevronDown, FolderGit2, Loader2, Search } from "lucide-react";
import type { FormEvent } from "react";

import type { RepoRef, Snapshot } from "../types/city";

interface RepoAnalyzePopoverProps {
  repos: RepoRef[];
  activeRepo: { owner: string; repo: string } | null;
  isStaticMode: boolean;
  snapshot: Snapshot | null;
  simCityLevel?: string;
  repoInput: string;
  analyzePct: number | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onSelectRepo: (owner: string, repo: string) => void;
  onChangeRepoInput: (val: string) => void;
  onAnalyzeSubmit: (e: FormEvent) => void;
  onOpenHealthModal: () => void;
}

function gradeBadgeTone(grade: string): string {
  if (grade.startsWith("A")) {
    return "bg-emerald-500/15 text-emerald-300 ring-emerald-400/35 hover:bg-emerald-500/25";
  }
  if (grade.startsWith("B")) {
    return "bg-amber-500/15 text-amber-300 ring-amber-400/35 hover:bg-amber-500/25";
  }
  return "bg-rose-500/15 text-rose-300 ring-rose-400/35 hover:bg-rose-500/25";
}

export function RepoAnalyzePopover({
  repos,
  activeRepo,
  isStaticMode,
  snapshot,
  simCityLevel,
  repoInput,
  analyzePct,
  isOpen,
  onToggleOpen,
  onClose,
  onSelectRepo,
  onChangeRepoInput,
  onAnalyzeSubmit,
  onOpenHealthModal,
}: RepoAnalyzePopoverProps) {
  const repoTitle = activeRepo ? `${activeRepo.owner}/${activeRepo.repo}` : "CodeCity";

  return (
    <div className="sim-panel pointer-events-auto relative flex h-10 items-center gap-1.5 rounded-xl px-2">
      <div data-popover-id="repo" className="relative flex items-center">
        <button
          type="button"
          data-testid="repo-switcher-btn"
          disabled={isStaticMode}
          onClick={onToggleOpen}
          title={isStaticMode ? repoTitle : "Switch repository or analyze a new path / GitHub URL"}
          className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-white/[0.07] disabled:cursor-default disabled:hover:bg-transparent"
        >
          <Building2 className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="max-w-[140px] truncate sm:max-w-[190px]">{repoTitle}</span>
          {!isStaticMode && (
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
                isOpen ? "rotate-180 text-slate-200" : ""
              }`}
            />
          )}
        </button>

        {!isStaticMode && isOpen && (
          <div
            data-testid="repo-analyze-popover"
            className="sim-popover absolute top-full left-0 z-40 mt-2 w-80 rounded-2xl p-3 text-xs"
          >
            {repos.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Analyzed Repositories
                </div>
                <div className="sim-scrollbar max-h-44 space-y-1 overflow-y-auto pr-0.5">
                  {repos.map((r) => {
                    const selected = activeRepo?.owner === r.owner && activeRepo?.repo === r.repo;
                    return (
                      <button
                        key={`${r.owner}/${r.repo}`}
                        type="button"
                        onClick={() => {
                          onSelectRepo(r.owner, r.repo);
                          onClose();
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left transition ${
                          selected
                            ? "bg-white/10 text-white ring-1 ring-white/15"
                            : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Check
                            className={`h-3.5 w-3.5 shrink-0 ${
                              selected ? "text-amber-400 opacity-100" : "opacity-0"
                            }`}
                          />
                          <span className="truncate font-medium">
                            {r.owner}/{r.repo}
                          </span>
                        </div>
                        <span className="shrink-0 rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-200">
                          {r.latest_grade}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <form
              onSubmit={(e) => {
                onAnalyzeSubmit(e);
                onClose();
              }}
              className="border-t border-white/10 pt-2.5"
            >
              <label className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <FolderGit2 className="h-3 w-3 text-sky-400" />
                <span>Analyze Local Path or GitHub URL</span>
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  data-testid="analyze-source-input"
                  value={repoInput}
                  onChange={(e) => onChangeRepoInput(e.target.value)}
                  placeholder=". or https://github.com/..."
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950/80 px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:border-amber-400/50 focus:outline-none"
                />
                <button
                  type="submit"
                  data-testid="analyze-submit-btn"
                  disabled={analyzePct !== null}
                  className="flex shrink-0 items-center gap-1 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-60"
                >
                  {analyzePct !== null ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  <span>Analyze</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {snapshot && (
        <>
          <div className="h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={onOpenHealthModal}
            title={`${snapshot.city_archetype_title}${simCityLevel ? ` · ${simCityLevel}` : ""} · ${snapshot.total_files} files · ${snapshot.total_sloc.toLocaleString()} SLOC — Click for City Report`}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs transition hover:bg-white/[0.06]"
          >
            <span
              data-testid="city-grade-badge"
              className={`rounded-md px-1.5 py-0.5 text-[11px] font-extrabold ring-1 transition ${gradeBadgeTone(snapshot.health_grade)}`}
            >
              {snapshot.health_grade}
            </span>
            <span className="sim-pixel-badge hidden text-[11px] text-slate-400 md:inline">
              {snapshot.total_files} files · {snapshot.total_sloc.toLocaleString()} SLOC
            </span>
          </button>
        </>
      )}
    </div>
  );
}

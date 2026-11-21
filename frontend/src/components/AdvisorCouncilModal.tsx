import { CheckCircle2, Crosshair, Database, Users, X, Zap } from "lucide-react";

import type { AdvisorMission } from "../game/missions";

interface AdvisorCouncilModalProps {
  open: boolean;
  missions: AdvisorMission[];
  claimedMissionIds: Set<string>;
  onClaimReward: (mission: AdvisorMission) => void;
  onFocusFile: (filePath: string) => void;
  onClose: () => void;
}

export function AdvisorCouncilModal({
  open,
  missions,
  claimedMissionIds,
  onClaimReward,
  onFocusFile,
  onClose,
}: AdvisorCouncilModalProps) {
  if (!open) return null;

  return (
    <div
      data-testid="advisor-council-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
    >
      <div className="sim-panel flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-700/70 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Users className="h-5 w-5 text-sky-400" />
            <div>
              <h2 className="text-base font-bold text-white">City Advisor Council &amp; SQL Quests</h2>
              <p className="text-xs text-slate-400">
                Live missions generated from DuckDB-Wasm SQL over your codebase architecture
              </p>
            </div>
          </div>
          <button
            type="button"
            title="Close advisors"
            onClick={onClose}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-5 md:grid-cols-2">
          {missions.map((m) => {
            const claimed = claimedMissionIds.has(m.id);
            return (
              <div
                key={m.id}
                data-testid={`advisor-quest-${m.id}`}
                className={`flex flex-col justify-between rounded-2xl border p-4 ${
                  m.completed
                    ? "border-emerald-500/40 bg-emerald-950/20"
                    : "border-slate-700/70 bg-slate-900/80"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{m.icon}</span>
                      <div>
                        <div className="text-xs font-bold text-white">{m.advisorName}</div>
                        <div className="text-[10px] uppercase tracking-wider text-sky-300">
                          {m.advisorRole}
                        </div>
                      </div>
                    </div>
                    <span className="flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-amber-300">
                      <Zap className="h-3 w-3" />+{m.rewardVelocity}
                    </span>
                  </div>

                  <h3 className="mt-2.5 text-sm font-bold text-slate-100">{m.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-300">{m.description}</p>

                  <div className="mt-2.5 rounded-xl bg-slate-950/80 p-2 font-mono text-[10px] text-slate-400">
                    <div className="flex items-center gap-1 text-sky-300">
                      <Database className="h-3 w-3" />
                      <span>{m.sqlFact}</span>
                    </div>
                    <div className="mt-1 truncate text-slate-500" title={m.sqlQuery}>
                      {m.sqlQuery}
                    </div>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span className={m.completed ? "font-semibold text-emerald-300" : "text-slate-300"}>
                        {m.progressLabel}
                      </span>
                      <span className="font-mono text-slate-400">{m.progressPct}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full transition-all ${
                          m.completed ? "bg-emerald-400" : "bg-sky-400"
                        }`}
                        style={{ width: `${m.progressPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    {m.targetFile ? (
                      <button
                        type="button"
                        onClick={() => {
                          onFocusFile(m.targetFile!);
                          onClose();
                        }}
                        className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-slate-700"
                      >
                        <Crosshair className="h-3 w-3" />
                        <span className="max-w-36 truncate">{m.targetFile}</span>
                      </button>
                    ) : (
                      <span />
                    )}

                    {m.completed && !claimed ? (
                      <button
                        type="button"
                        onClick={() => onClaimReward(m)}
                        className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-emerald-400"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Claim +{m.rewardVelocity}</span>
                      </button>
                    ) : claimed ? (
                      <span className="text-[11px] font-semibold text-emerald-400">✓ Claimed</span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

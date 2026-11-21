import { Anchor, Flame, PlaneTakeoff, ShieldCheck, X, Zap } from "lucide-react";
import { useState } from "react";

import type { CitySnapshotBundle } from "../data/cityDataClient";

export interface AuthorSummary {
  author: string;
  sole_files: string[];
  total_files: number;
}

interface DisastersMenuProps {
  open: boolean;
  bundle: CitySnapshotBundle | null;
  authors: AuthorSummary[];
  onTriggerPowerOutage: (targetFile: string) => void;
  onTriggerBusFactorVacation: (authorLabel: string, files: string[]) => void;
  onTriggerCrunchStorm: () => void;
  onTriggerSupplyDockStorm: (depName: string) => void;
  onClearDisasters: () => void;
  onClose: () => void;
}

export function DisastersMenu({
  open,
  bundle,
  authors,
  onTriggerPowerOutage,
  onTriggerBusFactorVacation,
  onTriggerCrunchStorm,
  onTriggerSupplyDockStorm,
  onClearDisasters,
  onClose,
}: DisastersMenuProps) {
  const [selectedHub, setSelectedHub] = useState("");
  const [selectedAuthor, setSelectedAuthor] = useState("");
  const [selectedDep, setSelectedDep] = useState("");

  if (!open || !bundle) return null;

  const hubCandidates = [...bundle.files]
    .sort((a, b) => Number(b.condition_flags?.fan_in ?? 0) - Number(a.condition_flags?.fan_in ?? 0))
    .slice(0, 12);
  const hubChoice = selectedHub || hubCandidates[0]?.file_path || "";

  const fallbackLoneFiles = bundle.files
    .filter((f) => f.distinct_authors_90d <= 1)
    .map((f) => f.file_path);
  const effectiveAuthors: AuthorSummary[] =
    authors.length > 0
      ? authors
      : [
          {
            author: "Primary Solo Maintainer (90d)",
            sole_files: fallbackLoneFiles.slice(0, 8),
            total_files: fallbackLoneFiles.length,
          },
        ];
  const chosenAuthor =
    effectiveAuthors.find((a) => a.author === selectedAuthor) ?? effectiveAuthors[0];

  const directDeps = bundle.deps.filter((d) => d.is_direct).slice(0, 12);
  const depChoice = selectedDep || directDeps[0]?.package_name || "uv.lock / bun.lock";

  return (
    <div
      data-testid="disasters-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
    >
      <div className="sim-panel flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-700/70 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Flame className="h-5 w-5 text-rose-400" />
            <div>
              <h2 className="text-base font-bold text-white">Playable Chaos Disasters</h2>
              <p className="text-xs text-slate-400">
                Stress-test architectural resilience against outages, vacations, crunches &amp; lockfile shocks
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2">
          {/* 1. Cascading Power Outage */}
          <div className="flex flex-col justify-between rounded-2xl border border-amber-500/35 bg-slate-900/80 p-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-amber-300">
                <Zap className="h-4 w-4" />
                <span>Cascading Power Outage</span>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Propagates blackout waves across transitive <code className="text-sky-300">file_imports</code>; Greenbelt Proving Parks contain spread.
              </p>
              <select
                value={hubChoice}
                onChange={(e) => setSelectedHub(e.target.value)}
                className="mt-2.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
              >
                {hubCandidates.map((f) => (
                  <option key={f.file_path} value={f.file_path}>
                    {f.file_path} (fan-in {String(f.condition_flags?.fan_in ?? 0)})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              data-testid="disaster-power-outage"
              disabled={!hubChoice}
              onClick={() => {
                onTriggerPowerOutage(hubChoice);
                onClose();
              }}
              className="mt-3 w-full rounded-xl bg-amber-500 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              Trigger Outage Wave
            </button>
          </div>

          {/* 2. Bus Factor Vacation */}
          <div className="flex flex-col justify-between rounded-2xl border border-rose-500/35 bg-slate-900/80 p-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-rose-300">
                <PlaneTakeoff className="h-4 w-4" />
                <span>Bus Factor Vacation</span>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Sidelines a Git author; every building where they were the sole 90-day maintainer goes dark with sirens.
              </p>
              <select
                value={chosenAuthor?.author ?? ""}
                onChange={(e) => setSelectedAuthor(e.target.value)}
                className="mt-2.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
              >
                {effectiveAuthors.map((a) => (
                  <option key={a.author} value={a.author}>
                    {a.author} ({a.sole_files.length} sole modules)
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              data-testid="disaster-bus-vacation"
              disabled={!chosenAuthor}
              onClick={() => {
                if (chosenAuthor) {
                  onTriggerBusFactorVacation(chosenAuthor.author, chosenAuthor.sole_files);
                  onClose();
                }
              }}
              className="mt-3 w-full rounded-xl bg-rose-500 py-1.5 text-xs font-bold text-white hover:bg-rose-400 disabled:opacity-50"
            >
              Send Author on Vacation
            </button>
          </div>

          {/* 3. Release Crunch Storm */}
          <div className="flex flex-col justify-between rounded-2xl border border-orange-500/35 bg-slate-900/80 p-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-orange-300">
                <Flame className="h-4 w-4" />
                <span>Release Crunch Storm</span>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Ignites high-churn untested hotspot towers with regression fires until contained by Proving Parks &amp; Fire Trucks.
              </p>
            </div>
            <button
              type="button"
              data-testid="disaster-crunch-storm"
              onClick={() => {
                onTriggerCrunchStorm();
                onClose();
              }}
              className="mt-3 w-full rounded-xl bg-orange-500 py-1.5 text-xs font-bold text-slate-950 hover:bg-orange-400"
            >
              Ignite Crunch Storm
            </button>
          </div>

          {/* 4. Supply Dock Storm */}
          <div className="flex flex-col justify-between rounded-2xl border border-sky-500/35 bg-slate-900/80 p-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-sky-300">
                <Anchor className="h-4 w-4" />
                <span>Supply Dock Storm</span>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Disrupts a Waterfront dependency pier and ripples outage alerts into importing districts.
              </p>
              <select
                value={depChoice}
                onChange={(e) => setSelectedDep(e.target.value)}
                className="mt-2.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
              >
                {directDeps.length > 0 ? (
                  directDeps.map((d) => (
                    <option key={`${d.ecosystem}-${d.package_name}`} value={d.package_name}>
                      {d.package_name} ({d.ecosystem})
                    </option>
                  ))
                ) : (
                  <option value="uv.lock / bun.lock">uv.lock / bun.lock</option>
                )}
              </select>
            </div>
            <button
              type="button"
              data-testid="disaster-supply-dock"
              onClick={() => {
                onTriggerSupplyDockStorm(depChoice);
                onClose();
              }}
              className="mt-3 w-full rounded-xl bg-sky-500 py-1.5 text-xs font-bold text-slate-950 hover:bg-sky-400"
            >
              Strike Supply Pier
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 px-6 py-3">
          <span className="text-[11px] text-slate-400">
            Proving Parks &amp; Co-Maintainers harden districts against disasters.
          </span>
          <button
            type="button"
            onClick={() => {
              onClearDisasters();
              onClose();
            }}
            className="flex items-center gap-1 rounded-xl bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-400/35 hover:bg-emerald-500/30"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>All Clear / Reset</span>
          </button>
        </div>
      </div>
    </div>
  );
}

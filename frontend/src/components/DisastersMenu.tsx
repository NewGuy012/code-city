import { Anchor, Flame, PlaneTakeoff, ShieldCheck, Zap } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { CitySnapshotBundle } from "../data/cityDataClient";
import type { AuthorSummary } from "../types/city";
import { ModalShell } from "./ModalShell";

function DisasterCard({
  borderClass,
  titleClass,
  btnClass,
  icon,
  title,
  description,
  testId,
  actionLabel,
  disabled,
  onTrigger,
  children,
}: {
  borderClass: string;
  titleClass: string;
  btnClass: string;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  testId: string;
  actionLabel: string;
  disabled?: boolean;
  onTrigger: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col justify-between rounded-2xl border bg-slate-900/80 p-4 ${borderClass}`}
    >
      <div>
        <div className={`flex items-center gap-2 text-sm font-bold ${titleClass}`}>
          {icon}
          <span>{title}</span>
        </div>
        <p className="mt-1 text-xs text-slate-300">{description}</p>
        {children}
      </div>
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={onTrigger}
        className={`mt-3 w-full rounded-xl py-1.5 text-xs font-bold disabled:opacity-50 ${btnClass}`}
      >
        {actionLabel}
      </button>
    </div>
  );
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
    <ModalShell
      open={open}
      testId="disasters-modal"
      title="Playable Chaos Disasters"
      subtitle="Stress-test architectural resilience against outages, vacations, crunches & lockfile shocks"
      icon={<Flame className="h-5 w-5 text-rose-400" />}
      onClose={onClose}
      footer={
        <>
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
        </>
      }
    >
      <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2">
        <DisasterCard
          borderClass="border-amber-500/35"
          titleClass="text-amber-300"
          btnClass="bg-amber-500 text-slate-950 hover:bg-amber-400"
          icon={<Zap className="h-4 w-4" />}
          title="Cascading Power Outage"
          description={
            <>
              Propagates blackout waves across transitive{" "}
              <code className="text-sky-300">file_imports</code>; Greenbelt Proving Parks contain
              spread.
            </>
          }
          testId="disaster-power-outage"
          actionLabel="Trigger Outage Wave"
          disabled={!hubChoice}
          onTrigger={() => {
            onTriggerPowerOutage(hubChoice);
            onClose();
          }}
        >
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
        </DisasterCard>

        <DisasterCard
          borderClass="border-rose-500/35"
          titleClass="text-rose-300"
          btnClass="bg-rose-500 text-white hover:bg-rose-400"
          icon={<PlaneTakeoff className="h-4 w-4" />}
          title="Bus Factor Vacation"
          description="Sidelines a Git author; every building where they were the sole 90-day maintainer goes dark with sirens."
          testId="disaster-bus-vacation"
          actionLabel="Send Author on Vacation"
          disabled={!chosenAuthor}
          onTrigger={() => {
            if (chosenAuthor) {
              onTriggerBusFactorVacation(chosenAuthor.author, chosenAuthor.sole_files);
              onClose();
            }
          }}
        >
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
        </DisasterCard>

        <DisasterCard
          borderClass="border-orange-500/35"
          titleClass="text-orange-300"
          btnClass="bg-orange-500 text-slate-950 hover:bg-orange-400"
          icon={<Flame className="h-4 w-4" />}
          title="Release Crunch Storm"
          description="Ignites high-churn untested hotspot towers with regression fires until contained by Proving Parks & Fire Trucks."
          testId="disaster-crunch-storm"
          actionLabel="Ignite Crunch Storm"
          onTrigger={() => {
            onTriggerCrunchStorm();
            onClose();
          }}
        />

        <DisasterCard
          borderClass="border-sky-500/35"
          titleClass="text-sky-300"
          btnClass="bg-sky-500 text-slate-950 hover:bg-sky-400"
          icon={<Anchor className="h-4 w-4" />}
          title="Supply Dock Storm"
          description="Disrupts a Waterfront dependency pier and ripples outage alerts into importing districts."
          testId="disaster-supply-dock"
          actionLabel="Strike Supply Pier"
          onTrigger={() => {
            onTriggerSupplyDockStorm(depChoice);
            onClose();
          }}
        >
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
        </DisasterCard>
      </div>
    </ModalShell>
  );
}

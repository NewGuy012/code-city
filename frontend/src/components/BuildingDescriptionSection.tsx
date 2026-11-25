import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  Cpu,
  Link2,
  Loader2,
  Package,
  Sparkles,
  Terminal,
} from "lucide-react";

import { ARCHETYPE_PLAIN_LABELS, sourceBadgeMeta } from "../data/buildingDescription";
import type {
  BlastRadiusResult,
  BuildingDescription,
  District,
  FileMetric,
  SymbolSummary,
} from "../types/city";

interface BuildingDescriptionSectionProps {
  file: FileMetric;
  district: District | null;
  description: BuildingDescription;
  outgoingImports: string[];
  blastRadius: BlastRadiusResult | null;
  isStaticMode: boolean;
  llmEnabled: boolean;
  detailsLoading: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPolishWithAi?: () => void;
  onSelectFile: (filePath: string) => void;
  onJumpToSymbol: (symbol: SymbolSummary) => void;
  onOpenCouplingTab: () => void;
}

const SYMBOL_BADGE_TONE: Record<string, string> = {
  component: "bg-sky-500/20 text-sky-300",
  hook: "bg-cyan-500/20 text-cyan-300",
  class: "bg-amber-500/20 text-amber-300",
  struct: "bg-amber-500/20 text-amber-300",
  interface: "bg-emerald-500/20 text-emerald-300",
  trait: "bg-emerald-500/20 text-emerald-300",
  fn: "bg-indigo-500/20 text-indigo-300",
  enum: "bg-purple-500/20 text-purple-300",
  type: "bg-teal-500/20 text-teal-300",
};

export function BuildingDescriptionSection({
  file,
  district,
  description,
  outgoingImports,
  blastRadius,
  isStaticMode,
  llmEnabled,
  detailsLoading,
  expanded,
  onToggleExpanded,
  onPolishWithAi,
  onSelectFile,
  onJumpToSymbol,
  onOpenCouplingTab,
}: BuildingDescriptionSectionProps) {
  const badge = sourceBadgeMeta(description.source, description.model);
  const directCallers = (blastRadius?.impacted_files ?? []).filter((d) => d.hop_distance === 1);
  const reasons = Array.isArray(file.role_signals?.reasons)
    ? file.role_signals.reasons.filter((r): r is string => typeof r === "string")
    : [];
  const roleLabel =
    ARCHETYPE_PLAIN_LABELS[file.building_archetype] ?? file.building_archetype.replace(/_/g, " ");
  const canPolish =
    !isStaticMode &&
    llmEnabled &&
    description.source !== "llamacpp" &&
    description.source !== "gemini" &&
    description.source !== "sandbox" &&
    Boolean(onPolishWithAi);

  const previewChips: string[] = [];
  if (description.key_symbols.length > 0) {
    previewChips.push(`${description.key_symbols.length} symbols`);
  }
  const totalConn = outgoingImports.length + directCallers.length;
  if (totalConn > 0) {
    previewChips.push(`${totalConn} links`);
  }
  if (description.endpoints.length > 0) {
    previewChips.push(`${description.endpoints_total || description.endpoints.length} routes`);
  }

  return (
    <div className="space-y-2">
      <div data-testid="building-summary-card" className="rounded-xl bg-white/[0.04] p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-semibold text-slate-200">
            <BookOpen className="h-3.5 w-3.5 text-amber-400" />
            <span>What It Does</span>
          </div>
          <div className="flex items-center gap-1.5">
            {detailsLoading && <Loader2 className="h-3 w-3 animate-spin text-sky-400" />}
            <span
              title={badge.title}
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${badge.toneClass}`}
            >
              {badge.label}
            </span>
          </div>
        </div>

        <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-200">
          {description.short_summary}
        </p>

        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-slate-400">
          <span>
            Role: <span className="text-slate-300">{roleLabel}</span> (
            {Math.round(file.role_confidence * 100)}%)
          </span>
          {canPolish && (
            <button
              type="button"
              data-testid="polish-ai-btn"
              onClick={onPolishWithAi}
              disabled={detailsLoading}
              className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 transition hover:bg-sky-500/25 disabled:opacity-50"
            >
              <Sparkles className="h-2.5 w-2.5" />
              <span>{detailsLoading ? "Summarizing..." : "AI Summary"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03]">
        <button
          type="button"
          data-testid="building-details-toggle"
          aria-expanded={expanded}
          aria-controls="building-details-content"
          onClick={onToggleExpanded}
          className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition hover:bg-white/[0.05]"
        >
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-slate-100">Detailed description</div>
            {!expanded && previewChips.length > 0 && (
              <div className="truncate text-[10px] text-slate-400">{previewChips.join(" · ")}</div>
            )}
          </div>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
              expanded ? "rotate-180 text-amber-300" : ""
            }`}
          />
        </button>

        {expanded && (
          <div
            id="building-details-content"
            data-testid="building-details-content"
            className="space-y-3 border-t border-white/[0.07] px-2.5 py-2.5 text-[11px]"
          >
            {description.detailed_overview !== description.short_summary && (
              <p className="leading-relaxed text-slate-200">{description.detailed_overview}</p>
            )}

            {description.responsibilities.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Key Responsibilities
                </div>
                <ul className="space-y-1 text-slate-300">
                  {description.responsibilities.map((item) => (
                    <li key={item} className="flex gap-1.5 leading-snug">
                      <span className="text-amber-400">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {description.readme_context && (
              <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-100/90">
                <span className="font-semibold text-amber-300">From docs: </span>
                {description.readme_context}
              </div>
            )}

            {(district?.summary_blurb || reasons.length > 0) && (
              <div className="rounded-lg bg-slate-950/60 px-2.5 py-1.5 text-[10.5px] text-slate-400">
                {district?.summary_blurb && (
                  <div>
                    <span className="font-semibold text-slate-300">Neighborhood: </span>
                    {district.summary_blurb}
                  </div>
                )}
                {reasons.length > 0 && (
                  <div className="mt-0.5">
                    <span className="font-semibold text-slate-300">Signals: </span>
                    {reasons.join(" · ")}
                  </div>
                )}
              </div>
            )}

            {description.endpoints.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                  <Terminal className="h-3 w-3" />
                  <span>
                    Routes &amp; Commands (
                    {description.endpoints_total || description.endpoints.length})
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {description.endpoints.map((ep) => (
                    <span
                      key={ep}
                      className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200 ring-1 ring-emerald-400/20"
                    >
                      {ep}
                    </span>
                  ))}
                  {description.endpoints_total > description.endpoints.length && (
                    <span className="px-1 py-0.5 text-[10px] text-slate-400">
                      +{description.endpoints_total - description.endpoints.length} more
                    </span>
                  )}
                </div>
              </div>
            )}

            {description.key_symbols.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-sky-300">
                  <Cpu className="h-3 w-3" />
                  <span>Key Code Parts (Click to View)</span>
                </div>
                <div className="space-y-1">
                  {description.key_symbols.map((sym) => {
                    const tone = SYMBOL_BADGE_TONE[sym.kind] ?? "bg-white/10 text-slate-300";
                    return (
                      <button
                        key={`${sym.kind}-${sym.name}-${sym.start_line}`}
                        type="button"
                        data-testid={`symbol-jump-${sym.name}`}
                        onClick={() => onJumpToSymbol(sym)}
                        title={`Jump to ${sym.name} at line ${sym.start_line}`}
                        className="w-full rounded-lg bg-slate-950/65 px-2 py-1.5 text-left transition hover:bg-white/[0.08]"
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-semibold ${tone}`}
                            >
                              {sym.kind}
                            </span>
                            <span className="truncate font-mono text-[11px] font-semibold text-white">
                              {sym.name}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-[9px] text-slate-500">
                            L{sym.start_line}
                          </span>
                        </div>
                        {sym.doc && (
                          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-slate-300">
                            {sym.doc}
                          </p>
                        )}
                        {sym.methods.length > 0 && (
                          <div className="mt-1 truncate font-mono text-[9.5px] text-slate-400">
                            methods: {sym.methods.join(", ")}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {(outgoingImports.length > 0 || directCallers.length > 0) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                    <Link2 className="h-3 w-3" />
                    <span>Connections</span>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenCouplingTab}
                    className="flex items-center gap-0.5 text-[10px] text-amber-300 hover:underline"
                  >
                    <span>Blast radius</span>
                    <ArrowRight className="h-2.5 w-2.5" />
                  </button>
                </div>

                {outgoingImports.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] text-slate-400">
                      Depends on ({outgoingImports.length}):
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {outgoingImports.slice(0, 8).map((target) => (
                        <button
                          key={target}
                          type="button"
                          onClick={() => onSelectFile(target)}
                          title={target}
                          className="max-w-full truncate rounded-md bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-white/10 transition hover:bg-white/[0.08] hover:text-white"
                        >
                          {target}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {directCallers.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] text-slate-400">
                      Used directly by ({directCallers.length}):
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {directCallers.slice(0, 8).map((dep) => (
                        <button
                          key={dep.file_path}
                          type="button"
                          onClick={() => onSelectFile(dep.file_path)}
                          title={dep.file_path}
                          className="max-w-full truncate rounded-md bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] text-amber-200 ring-1 ring-white/10 transition hover:bg-white/[0.08] hover:text-white"
                        >
                          {dep.file_path}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {description.external_packages.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-purple-300">
                  <Package className="h-3 w-3" />
                  <span>External Libraries</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {description.external_packages.map((pkg) => (
                    <span
                      key={pkg}
                      className="rounded bg-purple-500/10 px-1.5 py-0.5 font-mono text-[10px] text-purple-200 ring-1 ring-purple-400/20"
                    >
                      {pkg}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {description.health_notes.length > 0 && (
              <div className="space-y-1 rounded-lg border border-orange-400/20 bg-orange-950/25 px-2.5 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-orange-300">
                  Maintenance Notes
                </div>
                {description.health_notes.map((note) => (
                  <p key={note} className="text-[10.5px] leading-snug text-orange-100/90">
                    • {note}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

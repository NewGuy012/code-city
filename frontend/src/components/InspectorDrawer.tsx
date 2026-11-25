import {
  Activity,
  AlertTriangle,
  Building2,
  GitBranch,
  MessageSquarePlus,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  METRIC_PLAIN_EXPLANATIONS,
  extractBuildingDescription,
  synthesizeFallbackDescription,
} from "../data/buildingDescription";
import type { FixDiffResult } from "../data/cityDataClient";
import type {
  Annotation,
  BlastRadiusResult,
  BuildingDescription,
  District,
  FileMetric,
  FileSourcePayload,
  LintDiagnostic,
} from "../types/city";
import { BuildingDescriptionSection } from "./BuildingDescriptionSection";
import { CodeExplorerSection } from "./CodeExplorerSection";

interface InspectorDrawerProps {
  file: FileMetric | null;
  district: District | null;
  outgoingImports: string[];
  blastRadius: BlastRadiusResult | null;
  diagnostics: LintDiagnostic[];
  history: Array<{
    snapshot_idx: number;
    sloc: number;
    hotspot_score: number;
    lint_issue_count: number;
  }>;
  annotations: Annotation[];
  isStaticMode: boolean;
  llmEnabled: boolean;
  liveDescription: BuildingDescription | null;
  detailsLoading: boolean;
  sourcePayload: FileSourcePayload | null;
  sourceLoading: boolean;
  sourceError: string | null;
  onRequestLiveDetails: (filePath: string, enhanceLlm: boolean) => void;
  onRequestSourceCode: (filePath: string, full: boolean) => void;
  onRequestFixDiff: (filePath: string) => Promise<FixDiffResult>;
  onAddAnnotation: (payload: {
    file_path: string;
    author: string;
    tag: string;
    body: string;
  }) => Promise<void>;
  onSelectFile: (filePath: string) => void;
  onClose: () => void;
  className?: string;
}

type InspectorTab = "overview" | "coupling" | "notes";

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return <div className="flex h-9 items-center text-[11px] text-slate-500">Single snapshot</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const w = 112;
  const h = 34;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 4 - ((v - min) / span) * (h - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts} />
    </svg>
  );
}

export function InspectorDrawer({
  file,
  district,
  outgoingImports,
  blastRadius,
  diagnostics,
  history,
  annotations,
  isStaticMode,
  llmEnabled,
  liveDescription,
  detailsLoading,
  sourcePayload,
  sourceLoading,
  sourceError,
  onRequestLiveDetails,
  onRequestSourceCode,
  onRequestFixDiff,
  onAddAnnotation,
  onSelectFile,
  onClose,
  className = "absolute top-16 right-3 bottom-24 z-30",
}: InspectorDrawerProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [targetCodeLine, setTargetCodeLine] = useState<number | null>(null);
  const [fixDiff, setFixDiff] = useState<FixDiffResult | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [noteAuthor, setNoteAuthor] = useState("mayor");
  const [noteTag, setNoteTag] = useState("refactor");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);

  const filePath = file?.file_path ?? null;
  const storedDescription = file ? extractBuildingDescription(file) : null;
  const isSandboxVirtual = storedDescription?.source === "sandbox";

  useEffect(() => {
    setDetailsExpanded(false);
    setCodeExpanded(false);
    setTargetCodeLine(null);
    setFixDiff(null);
    setFixError(null);
    setNoteError(null);
  }, [filePath]);

  useEffect(() => {
    if (!filePath || isStaticMode || isSandboxVirtual || liveDescription) return;
    const storedSource = storedDescription?.source;
    if (!storedDescription) {
      onRequestLiveDetails(filePath, llmEnabled);
    } else if (llmEnabled && storedSource !== "llamacpp" && storedSource !== "gemini") {
      onRequestLiveDetails(filePath, true);
    }
  }, [
    filePath,
    isSandboxVirtual,
    isStaticMode,
    liveDescription,
    llmEnabled,
    onRequestLiveDetails,
    storedDescription,
  ]);

  useEffect(() => {
    if (!codeExpanded || !filePath || isStaticMode || isSandboxVirtual) return;
    if (!sourcePayload && !sourceLoading && !sourceError) {
      onRequestSourceCode(filePath, false);
    }
  }, [
    codeExpanded,
    filePath,
    isSandboxVirtual,
    isStaticMode,
    onRequestSourceCode,
    sourceError,
    sourceLoading,
    sourcePayload,
  ]);

  if (!file) return null;

  const incomingCount = Number(file.condition_flags?.fan_in ?? 0);
  const description =
    liveDescription ??
    storedDescription ??
    synthesizeFallbackDescription(file, {
      district,
      outgoingImports,
      incomingCount,
    });
  const fileNotes = annotations.filter((a) => a.file_path === file.file_path);
  const couplingCount =
    (blastRadius?.impacted_files.length ?? 0) + (blastRadius?.fault_lines.length ?? 0);
  const notesAndLintCount = diagnostics.length + fileNotes.length;

  async function handleFixClick() {
    if (!file) return;
    setFixLoading(true);
    setFixError(null);
    try {
      const res = await onRequestFixDiff(file.file_path);
      setFixDiff(res);
    } catch (err) {
      setFixError(err instanceof Error ? err.message : "Failed to preview fix");
    } finally {
      setFixLoading(false);
    }
  }

  async function handleNoteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !noteBody.trim()) return;
    setSavingNote(true);
    setNoteError(null);
    try {
      await onAddAnnotation({
        file_path: file.file_path,
        author: noteAuthor,
        tag: noteTag,
        body: noteBody.trim(),
      });
      setNoteBody("");
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setSavingNote(false);
    }
  }

  const statTiles = [
    { label: "SLOC", value: String(file.sloc), tone: "text-white" },
    { label: "Complexity", value: `Cx ${file.max_complexity}`, tone: "text-amber-300" },
    { label: "Hotspot", value: file.hotspot_score.toFixed(1), tone: "text-orange-400" },
    { label: "90d Churn", value: String(file.churn_90d), tone: "text-sky-300" },
    {
      label: "Bus Factor",
      value: String(file.distinct_authors_90d),
      tone: file.distinct_authors_90d <= 1 ? "text-rose-400" : "text-emerald-300",
    },
    {
      label: "Lint Debt",
      value: `${file.lint_issue_count}${file.format_drift ? "+f" : ""}`,
      tone: "text-purple-300",
    },
  ];

  const tabs: Array<{
    id: InspectorTab;
    label: string;
    badge?: number;
    badgeTone?: string;
  }> = [
    { id: "overview", label: "Overview" },
    { id: "coupling", label: "Coupling", badge: couplingCount, badgeTone: "text-amber-300" },
    { id: "notes", label: "Lint & Notes", badge: notesAndLintCount, badgeTone: "text-sky-300" },
  ];

  return (
    <aside
      data-testid="inspector-drawer"
      className={`sim-panel pointer-events-auto flex w-80 max-w-[calc(var(--hud-vw,100vw)-4.5rem)] flex-col overflow-hidden rounded-2xl ${className}`}
    >
      <div className="flex items-start justify-between gap-2 border-b border-white/10 px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            <Building2 className="h-3 w-3" />
            <span>{file.building_archetype.replace(/_/g, " ")}</span>
            <span className="text-slate-600">·</span>
            <span className="text-sky-300">{file.language}</span>
          </div>
          <h2
            className="mt-0.5 truncate font-mono text-xs font-bold text-white"
            title={file.file_path}
          >
            {file.file_path}
          </h2>
          <p className="truncate text-[11px] text-slate-400">
            {file.district_path}/ ·{" "}
            <span className="capitalize text-slate-300">{file.zone_type.replace(/_/g, " ")}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-white"
          title="Close inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1.5 border-b border-white/[0.07] px-3.5 py-2.5">
        {statTiles.map((t) => (
          <div
            key={t.label}
            title={METRIC_PLAIN_EXPLANATIONS[t.label]}
            className="rounded-lg bg-white/[0.04] px-2 py-1.5"
          >
            <div className="text-[9px] uppercase tracking-wider text-slate-400">{t.label}</div>
            <div className={`sim-pixel-badge font-mono text-xs font-bold ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5 text-[11px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`inspector-tab-${t.id}`}
            onClick={() => setActiveTab(t.id)}
            className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 font-medium transition ${
              activeTab === t.id
                ? "bg-white/[0.11] text-white"
                : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
            }`}
          >
            <span>{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && (
              <span className={`rounded bg-white/10 px-1 font-mono text-[9px] ${t.badgeTone}`}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="sim-scrollbar flex-1 space-y-3 overflow-y-auto px-3.5 py-3 text-xs">
        {activeTab === "overview" && (
          <>
            <BuildingDescriptionSection
              file={file}
              district={district}
              description={description}
              outgoingImports={outgoingImports}
              blastRadius={blastRadius}
              isStaticMode={isStaticMode}
              llmEnabled={llmEnabled}
              detailsLoading={detailsLoading}
              expanded={detailsExpanded}
              onToggleExpanded={() => setDetailsExpanded((v) => !v)}
              onPolishWithAi={() => onRequestLiveDetails(file.file_path, true)}
              onSelectFile={onSelectFile}
              onJumpToSymbol={(sym) => {
                setTargetCodeLine(sym.start_line || 1);
                setCodeExpanded(true);
                if (!isStaticMode && !isSandboxVirtual && !sourcePayload) {
                  onRequestSourceCode(file.file_path, false);
                }
              }}
              onOpenCouplingTab={() => setActiveTab("coupling")}
            />

            <CodeExplorerSection
              filePath={file.file_path}
              language={file.language}
              sloc={file.sloc}
              symbols={description.key_symbols}
              sourcePayload={sourcePayload}
              loading={sourceLoading}
              error={sourceError}
              isStaticMode={isStaticMode}
              isSandboxVirtual={isSandboxVirtual}
              expanded={codeExpanded}
              targetLine={targetCodeLine}
              onToggleExpanded={() => setCodeExpanded((v) => !v)}
              onSelectLine={(line) => setTargetCodeLine(line)}
              onLoadFullFile={() => onRequestSourceCode(file.file_path, true)}
            />

            {history.length > 0 && (
              <div className="rounded-xl bg-white/[0.04] p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                  <Activity className="h-3.5 w-3.5 text-sky-400" />
                  <span>Skyline History ({history.length} keyframes)</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] text-slate-400">SLOC Trend</div>
                    <Sparkline values={history.map((h) => h.sloc)} color="#38bdf8" />
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">Hotspot Heat</div>
                    <Sparkline values={history.map((h) => h.hotspot_score)} color="#f97316" />
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === "coupling" && (
          <>
            <div className="rounded-xl bg-white/[0.04] p-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                  <Zap className="h-3.5 w-3.5" />
                  <span>Blast Radius</span>
                </div>
                <span className="font-mono text-[11px] text-slate-400">
                  {blastRadius?.impacted_files.length ?? 0} impacted
                </span>
              </div>
              {blastRadius && blastRadius.impacted_files.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {blastRadius.impacted_files.map((dep) => (
                    <button
                      key={dep.file_path}
                      type="button"
                      onClick={() => onSelectFile(dep.file_path)}
                      className="flex w-full items-center justify-between rounded-lg bg-slate-950/60 px-2 py-1 text-left transition hover:bg-white/[0.08]"
                    >
                      <span className="truncate font-mono text-[11px] text-slate-200">
                        {dep.file_path}
                      </span>
                      <span
                        className={`ml-2 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                          dep.hop_distance === 1
                            ? "bg-amber-500/20 text-amber-300"
                            : "bg-sky-500/20 text-sky-300"
                        }`}
                      >
                        hop {dep.hop_distance}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  No downstream internal dependents detected.
                </p>
              )}
            </div>

            <div className="rounded-xl bg-white/[0.04] p-2.5">
              <div className="flex items-center gap-1.5 font-semibold text-purple-300">
                <GitBranch className="h-3.5 w-3.5" />
                <span>Seismic Fault Lines (Co-change)</span>
              </div>
              {blastRadius && blastRadius.fault_lines.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {blastRadius.fault_lines.map((pair) => {
                    const other = pair.file_a === file.file_path ? pair.file_b : pair.file_a;
                    return (
                      <button
                        key={`${pair.file_a}-${pair.file_b}`}
                        type="button"
                        onClick={() => onSelectFile(other)}
                        className="flex w-full items-center justify-between rounded-lg bg-purple-950/30 px-2 py-1 text-left transition hover:bg-purple-900/40"
                      >
                        <span className="truncate font-mono text-[11px] text-purple-200">
                          {other}
                        </span>
                        <span className="ml-2 shrink-0 font-mono text-[10px] text-purple-300">
                          {Math.round(pair.coupling_ratio * 100)}% ({pair.shared_commits}x)
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  No high-coupling co-change fault lines.
                </p>
              )}
            </div>
          </>
        )}

        {activeTab === "notes" && (
          <>
            <div className="rounded-xl bg-white/[0.04] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-purple-300">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Diagnostics ({diagnostics.length})</span>
                </div>
                {!isStaticMode &&
                  (file.language === "python" ||
                    file.language === "typescript" ||
                    file.language === "javascript") && (
                    <button
                      type="button"
                      data-testid="preview-fix-btn"
                      onClick={() => void handleFixClick()}
                      disabled={fixLoading}
                      className="flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2 py-1 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      <Wrench className="h-3 w-3" />
                      <span>{fixLoading ? "Checking..." : "Preview --fix"}</span>
                    </button>
                  )}
              </div>

              {diagnostics.length > 0 ? (
                <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto sim-scrollbar">
                  {diagnostics.map((d, idx) => (
                    <div
                      key={`${d.rule_code}-${d.line}-${idx}`}
                      className="rounded-lg bg-slate-950/60 p-2"
                    >
                      <div className="flex items-center justify-between font-mono text-[10px]">
                        <span className="font-bold text-purple-300">
                          {d.linter} · {d.rule_code}
                        </span>
                        <span className="text-slate-400">
                          L{d.line}:{d.col}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-300">{d.message}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  Clean air — zero diagnostics recorded here.
                </p>
              )}

              {fixError && (
                <div className="mt-2 rounded-lg border border-rose-500/35 bg-rose-950/40 px-2.5 py-1.5 text-[11px] text-rose-200">
                  {fixError}
                </div>
              )}

              {fixDiff && (
                <div className="mt-2.5 rounded-lg border border-emerald-500/35 bg-slate-950 p-2">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-emerald-300">
                    <span>{fixDiff.linter}</span>
                    <span>{fixDiff.message}</span>
                  </div>
                  {fixDiff.has_changes && (
                    <pre className="sim-scrollbar mt-1.5 max-h-40 overflow-auto font-mono text-[10px] leading-relaxed text-slate-200">
                      {fixDiff.diff}
                    </pre>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-xl bg-white/[0.04] p-2.5">
              <div className="flex items-center gap-1.5 font-semibold text-sky-300">
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span>Mayor Notes ({fileNotes.length})</span>
              </div>
              {fileNotes.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {fileNotes.map((n) => (
                    <div key={n.annotation_id} className="rounded-lg bg-slate-950/65 p-2">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="font-semibold text-amber-300">@{n.author}</span>
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300">
                          {n.tag}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-200">{n.body}</p>
                    </div>
                  ))}
                </div>
              )}

              {!isStaticMode && (
                <form onSubmit={(e) => void handleNoteSubmit(e)} className="mt-2 space-y-1.5">
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={noteAuthor}
                      onChange={(e) => setNoteAuthor(e.target.value)}
                      placeholder="author"
                      className="w-24 rounded-lg border border-white/10 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
                    />
                    <select
                      value={noteTag}
                      onChange={(e) => setNoteTag(e.target.value)}
                      className="rounded-lg border border-white/10 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
                    >
                      <option value="refactor">refactor</option>
                      <option value="onboarding">onboarding</option>
                      <option value="warning">warning</option>
                      <option value="note">note</option>
                    </select>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      data-testid="mayor-note-input"
                      value={noteBody}
                      onChange={(e) => setNoteBody(e.target.value)}
                      placeholder="Drop a Mayor note over Quack..."
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/80 px-2.5 py-1 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      data-testid="mayor-note-submit"
                      disabled={savingNote || !noteBody.trim()}
                      className="rounded-lg bg-sky-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                  {noteError && (
                    <div className="rounded-lg border border-rose-500/35 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200">
                      {noteError}
                    </div>
                  )}
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

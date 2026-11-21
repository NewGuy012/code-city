import {
  Activity,
  AlertTriangle,
  Building2,
  GitBranch,
  MessageSquarePlus,
  Sparkles,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { FixDiffResult } from "../data/cityDataClient";
import type { Annotation, BlastRadiusResult, FileMetric, LintDiagnostic } from "../types/city";

interface InspectorDrawerProps {
  file: FileMetric | null;
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
  onRequestFixDiff: (filePath: string) => Promise<FixDiffResult>;
  onAddAnnotation: (payload: {
    file_path: string;
    author: string;
    tag: string;
    body: string;
  }) => Promise<void>;
  onSelectFile: (filePath: string) => void;
  onClose: () => void;
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) {
    return <div className="flex h-10 items-center text-[11px] text-slate-500">Single snapshot</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const w = 120;
  const h = 36;
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
  blastRadius,
  diagnostics,
  history,
  annotations,
  isStaticMode,
  onRequestFixDiff,
  onAddAnnotation,
  onSelectFile,
  onClose,
}: InspectorDrawerProps) {
  const [fixDiff, setFixDiff] = useState<FixDiffResult | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [noteAuthor, setNoteAuthor] = useState("mayor");
  const [noteTag, setNoteTag] = useState("refactor");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    setFixDiff(null);
  }, [file?.file_path]);

  if (!file) return null;

  const reasons = Array.isArray(file.role_signals?.reasons)
    ? (file.role_signals.reasons as string[])
    : [];
  const fileNotes = annotations.filter((a) => a.file_path === file.file_path);

  async function handleFixClick() {
    if (!file) return;
    setFixLoading(true);
    try {
      const res = await onRequestFixDiff(file.file_path);
      setFixDiff(res);
    } finally {
      setFixLoading(false);
    }
  }

  async function handleNoteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !noteBody.trim()) return;
    setSavingNote(true);
    try {
      await onAddAnnotation({
        file_path: file.file_path,
        author: noteAuthor,
        tag: noteTag,
        body: noteBody.trim(),
      });
      setNoteBody("");
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <aside
      data-testid="inspector-drawer"
      className="sim-panel pointer-events-auto absolute top-28 right-3 bottom-24 z-30 flex w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl sm:bottom-44"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-slate-700/70 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
            <Building2 className="h-3.5 w-3.5" />
            <span>{file.building_archetype.replace(/_/g, " ")}</span>
            <span className="text-slate-500">·</span>
            <span className="text-sky-300">{file.language}</span>
          </div>
          <h2
            className="mt-0.5 truncate font-mono text-sm font-bold text-white"
            title={file.file_path}
          >
            {file.file_path}
          </h2>
          <p className="text-[11px] text-slate-400">
            District: <span className="text-slate-200">{file.district_path}/</span> · Zone{" "}
            <span className="capitalize text-slate-200">{file.zone_type.replace(/_/g, " ")}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          title="Close inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
        {/* Blueprint Metrics Grid */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-slate-900/90 p-2.5">
            <div className="text-[10px] uppercase text-slate-400">Footprint</div>
            <div className="mt-0.5 font-mono text-sm font-bold text-white">{file.sloc} SLOC</div>
          </div>
          <div className="rounded-xl bg-slate-900/90 p-2.5">
            <div className="text-[10px] uppercase text-slate-400">Complexity</div>
            <div className="mt-0.5 font-mono text-sm font-bold text-amber-300">
              Cx {file.max_complexity}
            </div>
          </div>
          <div className="rounded-xl bg-slate-900/90 p-2.5">
            <div className="text-[10px] uppercase text-slate-400">Hotspot</div>
            <div className="mt-0.5 font-mono text-sm font-bold text-orange-400">
              {file.hotspot_score.toFixed(1)}
            </div>
          </div>
          <div className="rounded-xl bg-slate-900/90 p-2.5">
            <div className="text-[10px] uppercase text-slate-400">90d Churn</div>
            <div className="mt-0.5 font-mono text-sm font-bold text-sky-300">{file.churn_90d}</div>
          </div>
          <div className="rounded-xl bg-slate-900/90 p-2.5">
            <div className="text-[10px] uppercase text-slate-400">Bus Factor</div>
            <div
              className={`mt-0.5 font-mono text-sm font-bold ${
                file.distinct_authors_90d <= 1 ? "text-rose-400" : "text-emerald-300"
              }`}
            >
              {file.distinct_authors_90d} {file.distinct_authors_90d === 1 ? "author" : "authors"}
            </div>
          </div>
          <div className="rounded-xl bg-slate-900/90 p-2.5">
            <div className="text-[10px] uppercase text-slate-400">Lint Debt</div>
            <div className="mt-0.5 font-mono text-sm font-bold text-purple-300">
              {file.lint_issue_count} {file.format_drift ? "+fmt" : ""}
            </div>
          </div>
        </div>

        {/* Classification Reasoning */}
        {reasons.length > 0 && (
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-2.5">
            <div className="flex items-center gap-1.5 font-semibold text-slate-200">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span>Blueprint Classification ({Math.round(file.role_confidence * 100)}%)</span>
            </div>
            <ul className="mt-1.5 space-y-1 text-slate-300">
              {reasons.map((r) => (
                <li key={r} className="leading-snug">
                  • {r}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Historical Sparklines */}
        {history.length > 0 && (
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-2.5">
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

        {/* Power-Outage Blast Radius & Seismic Fault Lines */}
        <div className="rounded-xl border border-amber-500/30 bg-slate-900/75 p-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-amber-300">
              <Zap className="h-3.5 w-3.5" />
              <span>Power-Outage Blast Radius</span>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              {blastRadius?.impacted_files.length ?? 0} impacted
            </span>
          </div>
          {blastRadius && blastRadius.impacted_files.length > 0 ? (
            <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
              {blastRadius.impacted_files.map((dep) => (
                <button
                  key={dep.file_path}
                  type="button"
                  onClick={() => onSelectFile(dep.file_path)}
                  className="flex w-full items-center justify-between rounded-lg bg-slate-950/70 px-2 py-1 text-left hover:bg-slate-800"
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
            <p className="mt-1.5 text-slate-400">No downstream internal dependents detected.</p>
          )}

          {blastRadius && blastRadius.fault_lines.length > 0 && (
            <div className="mt-2.5 border-t border-slate-800 pt-2">
              <div className="flex items-center gap-1.5 font-semibold text-purple-300">
                <GitBranch className="h-3.5 w-3.5" />
                <span>Seismic Fault Lines (Co-change)</span>
              </div>
              <div className="mt-1.5 space-y-1">
                {blastRadius.fault_lines.map((pair) => {
                  const other = pair.file_a === file.file_path ? pair.file_b : pair.file_a;
                  return (
                    <button
                      key={`${pair.file_a}-${pair.file_b}`}
                      type="button"
                      onClick={() => onSelectFile(other)}
                      className="flex w-full items-center justify-between rounded-lg bg-purple-950/30 px-2 py-1 text-left hover:bg-purple-900/40"
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
            </div>
          )}
        </div>

        {/* Lint Diagnostics & Live Auto-Fix Diff */}
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-2.5">
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
                  className="flex items-center gap-1 rounded-lg bg-emerald-500/20 px-2 py-1 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-400/35 hover:bg-emerald-500/30 disabled:opacity-50"
                >
                  <Wrench className="h-3 w-3" />
                  <span>{fixLoading ? "Checking..." : "Preview --fix"}</span>
                </button>
              )}
          </div>

          {diagnostics.length > 0 ? (
            <div className="mt-2 max-h-36 space-y-1.5 overflow-y-auto">
              {diagnostics.map((d, idx) => (
                <div
                  key={`${d.rule_code}-${d.line}-${idx}`}
                  className="rounded-lg bg-slate-950/70 p-2"
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
            <p className="mt-1.5 text-slate-400">Clean air — zero diagnostics recorded here.</p>
          )}

          {fixDiff && (
            <div className="mt-2.5 rounded-lg border border-emerald-500/35 bg-slate-950 p-2">
              <div className="flex items-center justify-between text-[11px] font-semibold text-emerald-300">
                <span>{fixDiff.linter}</span>
                <span>{fixDiff.message}</span>
              </div>
              {fixDiff.has_changes && (
                <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-[10px] leading-relaxed text-slate-200">
                  {fixDiff.diff}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Collaborative Mayor Notes (Quack + DuckLake Data Inlining) */}
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-2.5">
          <div className="flex items-center gap-1.5 font-semibold text-sky-300">
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span>Mayor Notes ({fileNotes.length})</span>
          </div>
          {fileNotes.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {fileNotes.map((n) => (
                <div key={n.annotation_id} className="rounded-lg bg-slate-950/75 p-2">
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
                  className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
                />
                <select
                  value={noteTag}
                  onChange={(e) => setNoteTag(e.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
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
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] text-slate-100 placeholder-slate-500"
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
            </form>
          )}
        </div>
      </div>
    </aside>
  );
}

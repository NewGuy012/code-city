import {
  Award,
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  History,
  Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  AnnotationChangeEvent,
  HealthReportData,
  QuackSnippetInfo,
} from "../data/cityDataClient";
import type { Annotation } from "../types/city";
import { ModalShell } from "./ModalShell";

interface HealthCardModalProps {
  open: boolean;
  report: HealthReportData | null;
  annotations: Annotation[];
  isStaticMode: boolean;
  onFetchQuackSnippet: () => Promise<QuackSnippetInfo>;
  onFetchAnnotationChanges: () => Promise<AnnotationChangeEvent[]>;
  onTriggerExport: () => Promise<{
    output_dir: string;
    badge_url: string;
    postcard_url: string | null;
  }>;
  onFocusFile: (filePath: string) => void;
  onClose: () => void;
}

export function HealthCardModal({
  open,
  report,
  annotations,
  isStaticMode,
  onFetchQuackSnippet,
  onFetchAnnotationChanges,
  onTriggerExport,
  onFocusFile,
  onClose,
}: HealthCardModalProps) {
  const [tab, setTab] = useState<"report" | "quack" | "changelog">("report");
  const [quackInfo, setQuackInfo] = useState<QuackSnippetInfo | null>(null);
  const [changes, setChanges] = useState<AnnotationChangeEvent[]>([]);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOut, setExportOut] = useState<{
    output_dir: string;
    badge_url: string;
    postcard_url: string | null;
  } | null>(null);

  useEffect(() => {
    if (!open || isStaticMode) return;
    void onFetchQuackSnippet()
      .then(setQuackInfo)
      .catch(() => {});
    void onFetchAnnotationChanges()
      .then(setChanges)
      .catch(() => {});
  }, [isStaticMode, onFetchAnnotationChanges, onFetchQuackSnippet, open]);

  if (!open || !report) return null;

  const langEntries = Object.entries(report.language_breakdown).sort((a, b) => b[1] - a[1]);
  const totalLangFiles = Math.max(
    1,
    langEntries.reduce((acc, [, n]) => acc + n, 0),
  );

  function copyText(txt: string) {
    void navigator.clipboard?.writeText(txt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await onTriggerExport();
      setExportOut(res);
    } finally {
      setExporting(false);
    }
  }

  return (
    <ModalShell
      open={open}
      testId="health-modal"
      title={report.city_archetype_title}
      subtitle={`${report.owner}/${report.repo} · OSS Health Report`}
      icon={
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/20 text-xl font-black text-amber-300 ring-1 ring-amber-400/40">
          {report.health_grade}
        </div>
      }
      closeTitle="Close report"
      onClose={onClose}
    >
      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-6 py-2 text-xs">
        <button
          type="button"
          onClick={() => setTab("report")}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-semibold transition ${
            tab === "report"
              ? "bg-amber-500/20 text-amber-300"
              : "text-slate-400 hover:bg-slate-800 hover:text-white"
          }`}
        >
          <Award className="h-3.5 w-3.5" />
          <span>City Postcard &amp; Export</span>
        </button>
        {!isStaticMode && (
          <>
            <button
              type="button"
              data-testid="tab-quack-cli"
              onClick={() => setTab("quack")}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-semibold transition ${
                tab === "quack"
                  ? "bg-sky-500/20 text-sky-300"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              <span>Attach via DuckDB CLI</span>
            </button>
            <button
              type="button"
              data-testid="tab-table-changes"
              onClick={() => setTab("changelog")}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-semibold transition ${
                tab === "changelog"
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <History className="h-3.5 w-3.5" />
              <span>Mayor Feed ({changes.length || annotations.length})</span>
            </button>
          </>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4 text-xs">
        {tab === "report" && (
          <>
            {/* Score Strip */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl bg-slate-900/90 p-3">
                <div className="text-[10px] uppercase text-slate-400">Health Score</div>
                <div className="mt-0.5 font-mono text-lg font-bold text-emerald-300">
                  {report.health_score.toFixed(1)}/100
                </div>
              </div>
              <div className="rounded-2xl bg-slate-900/90 p-3">
                <div className="text-[10px] uppercase text-slate-400">Greenbelt Tests</div>
                <div className="mt-0.5 font-mono text-lg font-bold text-green-300">
                  {report.greenbelt_pct}%
                </div>
              </div>
              <div className="rounded-2xl bg-slate-900/90 p-3">
                <div className="text-[10px] uppercase text-slate-400">Lint Debt</div>
                <div className="mt-0.5 font-mono text-lg font-bold text-purple-300">
                  {report.total_lint_issues}
                </div>
              </div>
              <div className="rounded-2xl bg-slate-900/90 p-3">
                <div className="text-[10px] uppercase text-slate-400">Bus Factor = 1</div>
                <div className="mt-0.5 font-mono text-lg font-bold text-rose-300">
                  {report.lone_keeper_files} hubs
                </div>
              </div>
            </div>

            {/* Language Zoning Breakdown */}
            <div className="rounded-2xl bg-slate-900/80 p-3.5">
              <div className="font-semibold text-slate-200">Polyglot Language Zoning</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {langEntries.map(([lang, count]) => (
                  <span
                    key={lang}
                    className="rounded-lg bg-slate-800 px-2.5 py-1 font-mono text-[11px] text-slate-200"
                  >
                    {lang}: {count} ({Math.round((count / totalLangFiles) * 100)}%)
                  </span>
                ))}
              </div>
            </div>

            {/* Top Hotspots */}
            <div className="rounded-2xl bg-slate-900/80 p-3.5">
              <div className="font-semibold text-slate-200">Top Refactor Hotspots</div>
              <div className="mt-2 space-y-1.5">
                {report.top_hotspots.slice(0, 5).map((h) => (
                  <button
                    key={h.file_path}
                    type="button"
                    onClick={() => {
                      onFocusFile(h.file_path);
                      onClose();
                    }}
                    className="flex w-full items-center justify-between rounded-xl bg-slate-950/70 px-3 py-1.5 text-left hover:bg-slate-800"
                  >
                    <span className="truncate font-mono text-[11px] text-slate-100">
                      {h.file_path}
                    </span>
                    <span className="ml-2 shrink-0 font-mono text-[11px] text-orange-400">
                      {h.hotspot_score.toFixed(1)} · Cx {h.max_complexity}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Static Export + Postcard + Badge */}
            {!isStaticMode && (
              <div className="rounded-2xl border border-amber-500/35 bg-slate-900/85 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-amber-300">
                      Shareable Zero-Backend OSS Bundle &amp; Postcard
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      Packages DuckDB-Wasm + Parquet + SVG Badge + Playwright PNG Postcard.
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="export-static-btn"
                    onClick={() => void handleExport()}
                    disabled={exporting}
                    className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-60"
                  >
                    {exporting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span>{exporting ? "Exporting..." : "Export Static + Postcard"}</span>
                  </button>
                </div>

                {exportOut && (
                  <div className="mt-3 space-y-2 rounded-xl bg-slate-950/80 p-3">
                    <div className="font-mono text-[11px] text-emerald-300">
                      Bundle ready: {exportOut.output_dir}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <img src={exportOut.badge_url} alt="CodeCity Grade Badge" className="h-6" />
                      {exportOut.postcard_url && (
                        <a
                          href={exportOut.postcard_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-sky-300 underline"
                        >
                          <span>Open PNG Postcard</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tab === "quack" && quackInfo && (
          <div className="space-y-3">
            <p className="text-slate-300">
              Connect directly to the live DuckLake 1.1 catalog from your DuckDB 2.0 CLI using the{" "}
              <code className="text-sky-300">quack:</code> protocol:
            </p>
            <div className="relative rounded-2xl border border-slate-700 bg-slate-950 p-3.5">
              <button
                type="button"
                onClick={() => copyText(quackInfo.snippet)}
                className="absolute top-3 right-3 flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
              <pre className="overflow-x-auto pr-16 font-mono text-[11px] leading-relaxed text-sky-200">
                {quackInfo.snippet}
              </pre>
            </div>
            <div className="rounded-xl bg-slate-900/75 p-3 text-[11px] text-slate-400">
              CORS-enabled Quack HTTP Proxy:{" "}
              <span className="font-mono text-slate-200">{quackInfo.proxy_url}</span>
            </div>
          </div>
        )}

        {tab === "changelog" && (
          <div className="space-y-2">
            <div className="text-slate-300">
              Powered by DuckLake 1.1 Data Inlining +{" "}
              <code className="text-emerald-300">ducklake_table_changes()</code>:
            </div>
            {changes.length > 0 ? (
              changes.map((c) => (
                <div
                  key={`${c.snapshot_id}-${c.annotation_id}`}
                  className="rounded-xl bg-slate-900/90 p-3"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-mono font-semibold text-emerald-300">
                      snap #{c.snapshot_id} · {c.change_type} · @{c.author}
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-amber-300">
                      {c.tag}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-sky-300">{c.file_path}</div>
                  <p className="mt-1 text-slate-200">{c.body}</p>
                </div>
              ))
            ) : (
              <p className="text-slate-400">
                No Mayor notes recorded yet. Select any building to drop a note!
              </p>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

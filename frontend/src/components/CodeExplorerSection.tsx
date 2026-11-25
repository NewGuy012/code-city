import { Check, ChevronDown, Code2, Copy, Loader2, Maximize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { type CodeTokenKind, tokenizeCodeLines } from "../data/codeHighlight";
import type { FileSourcePayload, SymbolSummary } from "../types/city";
import { ModalShell } from "./ModalShell";
import { useCopyFeedback } from "./hudPopover";

interface CodeExplorerSectionProps {
  filePath: string;
  language: string;
  sloc: number;
  symbols: SymbolSummary[];
  sourcePayload: FileSourcePayload | null;
  loading: boolean;
  error: string | null;
  isStaticMode: boolean;
  isSandboxVirtual: boolean;
  expanded: boolean;
  targetLine: number | null;
  onToggleExpanded: () => void;
  onSelectLine: (line: number) => void;
  onLoadFullFile: () => void;
}

const TOKEN_CLASSES: Record<CodeTokenKind, string> = {
  plain: "text-slate-200",
  keyword: "text-sky-300 font-medium",
  string: "text-emerald-300",
  comment: "text-slate-500 italic",
  number: "text-amber-300",
  type: "text-purple-300",
};

function CodeLinesView({
  payload,
  targetLine,
  maxHeightClass,
}: {
  payload: FileSourcePayload;
  targetLine: number | null;
  maxHeightClass: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tokenized = useMemo(
    () => tokenizeCodeLines(payload.content, payload.language),
    [payload.content, payload.language],
  );

  useEffect(() => {
    if (!targetLine || !containerRef.current) return;
    const row = containerRef.current.querySelector(`[data-line="${targetLine}"]`);
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [payload.content, targetLine]);

  return (
    <div
      ref={containerRef}
      className={`sim-scrollbar overflow-auto rounded-lg bg-slate-950/90 font-mono text-[10.5px] leading-relaxed ${maxHeightClass}`}
    >
      <div className="min-w-max py-1.5">
        {tokenized.map((tokens, idx) => {
          const lineNo = idx + 1;
          const highlighted = targetLine === lineNo;
          return (
            <div
              key={lineNo}
              data-line={lineNo}
              className={`flex px-2 ${
                highlighted ? "bg-amber-500/20 ring-1 ring-inset ring-amber-400/40" : ""
              }`}
            >
              <span className="mr-3 inline-block w-8 shrink-0 select-none text-right text-[9.5px] text-slate-600">
                {lineNo}
              </span>
              <span className="whitespace-pre">
                {tokens.length === 0
                  ? " "
                  : tokens.map((tok, tIdx) => (
                      <span key={tIdx} className={TOKEN_CLASSES[tok.kind]}>
                        {tok.text}
                      </span>
                    ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CodeExplorerSection({
  filePath,
  language,
  sloc,
  symbols,
  sourcePayload,
  loading,
  error,
  isStaticMode,
  isSandboxVirtual,
  expanded,
  targetLine,
  onToggleExpanded,
  onSelectLine,
  onLoadFullFile,
}: CodeExplorerSectionProps) {
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copied, copyCode] = useCopyFeedback();

  useEffect(() => {
    setFullscreenOpen(false);
  }, [filePath]);

  const jumpSymbols = symbols.filter((s) => s.start_line > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03]">
      <button
        type="button"
        data-testid="building-code-toggle"
        aria-expanded={expanded}
        aria-controls="building-code-content"
        onClick={onToggleExpanded}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left transition hover:bg-white/[0.05]"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Code2 className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-slate-100">Explore code</div>
            {!expanded && (
              <div className="truncate text-[10px] text-slate-400">
                {sloc} lines · {language}
              </div>
            )}
          </div>
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
            expanded ? "rotate-180 text-sky-300" : ""
          }`}
        />
      </button>

      {expanded && (
        <div
          id="building-code-content"
          data-testid="building-code-content"
          className="space-y-2 border-t border-white/[0.07] px-2.5 py-2.5 text-[11px]"
        >
          {isStaticMode ? (
            <p className="rounded-lg bg-slate-950/60 p-2 text-[11px] text-slate-400">
              Live source viewing is unavailable in read-only static export mode. Run{" "}
              <code className="text-sky-300">codecity serve</code> locally to browse source code.
            </p>
          ) : isSandboxVirtual ? (
            <p className="rounded-lg bg-purple-950/30 p-2 text-[11px] text-purple-200">
              This is a simulated Mayor sandbox module and does not have a committed file on disk
              yet.
            </p>
          ) : loading && !sourcePayload ? (
            <div className="flex items-center gap-2 py-4 text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
              <span>Loading source code...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-rose-500/35 bg-rose-950/40 p-2 text-[11px] text-rose-200">
              {error}
            </div>
          ) : sourcePayload ? (
            <>
              <div className="flex items-center justify-between gap-1.5">
                {jumpSymbols.length > 0 ? (
                  <select
                    aria-label="Jump to symbol"
                    value={targetLine ?? ""}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (val > 0) onSelectLine(val);
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/90 px-2 py-1 text-[10.5px] text-slate-200 focus:outline-none"
                  >
                    <option value="">Jump to symbol...</option>
                    {jumpSymbols.map((sym) => (
                      <option
                        key={`${sym.kind}-${sym.name}-${sym.start_line}`}
                        value={sym.start_line}
                      >
                        {sym.kind}: {sym.name} (L{sym.start_line})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="font-mono text-[10px] text-slate-400">
                    {sourcePayload.total_lines} lines · {sourcePayload.commit_sha.slice(0, 7)}
                  </span>
                )}

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => copyCode(sourcePayload.content)}
                    title="Copy visible code"
                    className="rounded-lg bg-white/[0.07] p-1 text-slate-300 transition hover:bg-white/[0.14] hover:text-white"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    data-testid="code-fullscreen-btn"
                    onClick={() => setFullscreenOpen(true)}
                    title="Open code in wide reader"
                    className="flex items-center gap-1 rounded-lg bg-sky-500/15 px-1.5 py-1 text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/25"
                  >
                    <Maximize2 className="h-3 w-3" />
                    <span>Expand</span>
                  </button>
                </div>
              </div>

              <CodeLinesView
                payload={sourcePayload}
                targetLine={targetLine}
                maxHeightClass="max-h-64"
              />

              {sourcePayload.truncated && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-950/75 px-2 py-1 text-[10px] text-slate-400">
                  <span>Showing preview ({sourcePayload.total_lines} total lines)</span>
                  <button
                    type="button"
                    onClick={onLoadFullFile}
                    disabled={loading}
                    className="font-semibold text-sky-300 hover:underline disabled:opacity-50"
                  >
                    {loading ? "Loading..." : "Load full file"}
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      <ModalShell
        open={fullscreenOpen && sourcePayload !== null}
        testId="code-fullscreen-modal"
        maxWidthClass="max-w-5xl"
        title={filePath}
        subtitle={
          sourcePayload
            ? `${sourcePayload.language} · ${sourcePayload.total_lines} lines · snapshot ${sourcePayload.commit_sha.slice(0, 7)}`
            : undefined
        }
        icon={<Code2 className="h-5 w-5 text-sky-400" />}
        closeTitle="Close code viewer"
        onClose={() => setFullscreenOpen(false)}
      >
        {sourcePayload && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:flex-row">
            {jumpSymbols.length > 0 && (
              <div className="sim-scrollbar flex max-h-40 shrink-0 flex-row gap-1 overflow-auto rounded-xl bg-slate-900/80 p-2 sm:max-h-full sm:w-56 sm:flex-col">
                <div className="hidden px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 sm:block">
                  Symbols ({jumpSymbols.length})
                </div>
                {jumpSymbols.map((sym) => (
                  <button
                    key={`fs-${sym.kind}-${sym.name}-${sym.start_line}`}
                    type="button"
                    onClick={() => onSelectLine(sym.start_line)}
                    className={`flex shrink-0 items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-[11px] transition ${
                      targetLine === sym.start_line
                        ? "bg-amber-500/20 text-amber-200"
                        : "text-slate-300 hover:bg-white/[0.06]"
                    }`}
                  >
                    <span className="truncate font-mono">{sym.name}</span>
                    <span className="shrink-0 font-mono text-[9.5px] text-slate-500">
                      L{sym.start_line}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">
                  {sourcePayload.truncated ? "Preview truncated for speed" : "Full source file"}
                </span>
                <div className="flex items-center gap-2">
                  {sourcePayload.truncated && (
                    <button
                      type="button"
                      onClick={onLoadFullFile}
                      className="rounded-lg bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/25"
                    >
                      Load full file
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => copyCode(sourcePayload.content)}
                    className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>{copied ? "Copied" : "Copy code"}</span>
                  </button>
                </div>
              </div>
              <CodeLinesView
                payload={sourcePayload}
                targetLine={targetLine}
                maxHeightClass="flex-1 min-h-[24rem]"
              />
            </div>
          </div>
        )}
      </ModalShell>
    </div>
  );
}

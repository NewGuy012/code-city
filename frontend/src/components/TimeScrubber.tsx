import {
  ChevronDown,
  ChevronUp,
  GitCommitHorizontal,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Tag,
} from "lucide-react";
import { useState } from "react";

import type { Snapshot } from "../types/city";

interface TimeScrubberProps {
  snapshots: Snapshot[];
  snapshotIdx: number;
  isPlaying: boolean;
  addedCount: number;
  removedCount: number;
  onSelectSnapshot: (idx: number) => void;
  onTogglePlay: () => void;
}

function formatSnapshotDate(raw: string): string {
  const num = Number(raw);
  if (Number.isFinite(num) && num > 1_000_000_000) {
    // Handle DuckDB-Wasm timestamp epoch ms (or microseconds if huge)
    const ms = num > 1e14 ? Math.floor(num / 1000) : num;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return raw.slice(0, 10);
}

export function TimeScrubber({
  snapshots,
  snapshotIdx,
  isPlaying,
  addedCount,
  removedCount,
  onSelectSnapshot,
  onTogglePlay,
}: TimeScrubberProps) {
  const [expanded, setExpanded] = useState(false);

  if (snapshots.length === 0) return null;

  const curPos = Math.max(
    0,
    snapshots.findIndex((s) => s.snapshot_idx === snapshotIdx),
  );
  const current = snapshots[curPos] ?? snapshots[0];
  const dateLabel = formatSnapshotDate(current.committed_at);
  const renderMeta = (compact: boolean) => (
    <>
      <span className="flex items-center gap-1 font-mono text-[11px] text-sky-300">
        <GitCommitHorizontal className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
        {current.commit_sha.slice(0, 7)}
      </span>
      <span className={compact ? "hidden text-[11px] text-slate-400 md:inline" : "text-slate-400"}>
        {dateLabel}
      </span>
      {current.git_tag && (
        <span
          className={`${compact ? "hidden sm:flex rounded px-1.5 py-px" : "flex rounded-md px-1.5 py-0.5"} items-center gap-0.5 bg-amber-500/15 font-mono text-[10px] font-semibold text-amber-300`}
        >
          <Tag className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
          {current.git_tag}
        </span>
      )}
      <span
        className={`sim-pixel-badge rounded bg-white/[0.07] px-1.5 ${compact ? "py-px font-mono text-[10px] text-slate-200" : "py-0.5 text-slate-300"}`}
      >
        {compact
          ? `${curPos + 1}/${snapshots.length}`
          : `Snapshot ${curPos + 1}/${snapshots.length}`}
      </span>
      {(addedCount > 0 || removedCount > 0) && (
        <span
          className={`${compact ? "hidden sm:flex gap-1" : "flex gap-1.5"} items-center font-mono text-[10px]`}
        >
          {addedCount > 0 && (
            <span className="text-emerald-400">
              +{addedCount}
              {compact ? "" : " built"}
            </span>
          )}
          {removedCount > 0 && (
            <span className="text-rose-400">
              -{removedCount}
              {compact ? "" : " razed"}
            </span>
          )}
        </span>
      )}
    </>
  );

  if (!expanded) {
    return (
      <div
        data-testid="time-scrubber"
        className="sim-panel pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-xl px-1.5 text-xs"
      >
        <button
          type="button"
          data-testid="time-play-btn"
          onClick={onTogglePlay}
          title={isPlaying ? "Pause Time-Lapse" : "Play Git History Time-Lapse"}
          className={`flex h-6 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold transition ${
            isPlaying
              ? "bg-amber-400 text-slate-950"
              : "bg-white/[0.08] text-amber-300 hover:bg-amber-400 hover:text-slate-950"
          }`}
        >
          {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          <span className="hidden sm:inline">{isPlaying ? "Pause" : "Time-Lapse"}</span>
        </button>

        <button
          type="button"
          data-testid="time-expand-btn"
          onClick={() => setExpanded(true)}
          title="Expand commit timeline scrubber"
          className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-white/[0.06]"
        >
          {renderMeta(true)}
          <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="time-scrubber"
      className="sim-popover pointer-events-auto flex w-[min(520px,calc(100vw-1.5rem))] flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-xs"
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const prev = snapshots[Math.max(0, curPos - 1)];
              if (prev) onSelectSnapshot(prev.snapshot_idx);
            }}
            disabled={curPos <= 0}
            className="rounded-lg p-1 text-slate-300 hover:bg-white/[0.08] disabled:opacity-30"
            title="Previous keyframe"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="time-play-btn"
            onClick={onTogglePlay}
            className="flex h-7 items-center gap-1 rounded-lg bg-amber-400 px-2.5 text-[11px] font-bold text-slate-950 transition hover:bg-amber-300"
          >
            {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            <span>{isPlaying ? "Pause" : "Play"}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const next = snapshots[Math.min(snapshots.length - 1, curPos + 1)];
              if (next) onSelectSnapshot(next.snapshot_idx);
            }}
            disabled={curPos >= snapshots.length - 1}
            className="rounded-lg p-1 text-slate-300 hover:bg-white/[0.08] disabled:opacity-30"
            title="Next keyframe"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>
        </div>

        <input
          type="range"
          data-testid="time-slider"
          min={0}
          max={Math.max(0, snapshots.length - 1)}
          value={curPos}
          onChange={(e) => {
            const target = snapshots[Number(e.target.value)];
            if (target) onSelectSnapshot(target.snapshot_idx);
          }}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-amber-400"
        />

        <button
          type="button"
          data-testid="time-collapse-btn"
          onClick={() => setExpanded(false)}
          title="Collapse timeline"
          className="rounded-lg p-1 text-slate-400 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2">{renderMeta(false)}</div>

        <div className="hidden items-center gap-1 sm:flex">
          {snapshots
            .filter((s) => s.git_tag)
            .slice(-4)
            .map((s) => (
              <button
                key={s.snapshot_idx}
                type="button"
                onClick={() => onSelectSnapshot(s.snapshot_idx)}
                className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                  s.snapshot_idx === snapshotIdx
                    ? "bg-amber-400 font-bold text-slate-950"
                    : "bg-white/[0.07] text-slate-300 hover:bg-white/[0.14]"
                }`}
              >
                {s.git_tag}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

import { GitCommitHorizontal, Pause, Play, SkipBack, SkipForward, Tag } from "lucide-react";

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
  if (snapshots.length === 0) return null;

  const curPos = Math.max(
    0,
    snapshots.findIndex((s) => s.snapshot_idx === snapshotIdx),
  );
  const current = snapshots[curPos] ?? snapshots[0];
  const dateLabel = formatSnapshotDate(current.committed_at);

  return (
    <div
      data-testid="time-scrubber"
      className="sim-panel pointer-events-auto flex flex-col gap-2 rounded-2xl px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              const prev = snapshots[Math.max(0, curPos - 1)];
              if (prev) onSelectSnapshot(prev.snapshot_idx);
            }}
            disabled={curPos <= 0}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-35"
            title="Previous keyframe"
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="time-play-btn"
            onClick={onTogglePlay}
            className="flex items-center gap-1 rounded-xl bg-amber-500 px-3 py-1 text-xs font-bold text-slate-950 transition hover:bg-amber-400"
          >
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            <span>{isPlaying ? "Pause" : "Time-Lapse"}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const next = snapshots[Math.min(snapshots.length - 1, curPos + 1)];
              if (next) onSelectSnapshot(next.snapshot_idx);
            }}
            disabled={curPos >= snapshots.length - 1}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 disabled:opacity-35"
            title="Next keyframe"
          >
            <SkipForward className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="flex items-center gap-1 font-mono text-sky-300">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            {current.commit_sha.slice(0, 7)}
          </span>
          <span className="text-slate-400">{dateLabel}</span>
          {current.git_tag && (
            <span className="flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-300 ring-1 ring-amber-400/35">
              <Tag className="h-3 w-3" />
              {current.git_tag}
            </span>
          )}
          <span className="sim-pixel-badge rounded-md bg-slate-800 px-2 py-0.5 text-slate-300">
            Snapshot {curPos + 1}/{snapshots.length}
          </span>
          {(addedCount > 0 || removedCount > 0) && (
            <span className="flex items-center gap-1.5 rounded-md bg-slate-900 px-2 py-0.5 font-mono text-[11px]">
              {addedCount > 0 && <span className="text-emerald-400">+{addedCount} built</span>}
              {removedCount > 0 && <span className="text-rose-400">-{removedCount} razed</span>}
            </span>
          )}
        </div>
      </div>

      {/* Timeline Slider & Tag Chips */}
      <div className="flex items-center gap-3">
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
          className="h-1.5 flex-1 cursor-pointer accent-amber-400"
        />
        <div className="hidden items-center gap-1 md:flex">
          {snapshots
            .filter((s) => s.git_tag)
            .slice(-5)
            .map((s) => (
              <button
                key={s.snapshot_idx}
                type="button"
                onClick={() => onSelectSnapshot(s.snapshot_idx)}
                className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] transition ${
                  s.snapshot_idx === snapshotIdx
                    ? "bg-amber-500 text-slate-950 font-bold"
                    : "bg-slate-800/80 text-slate-300 hover:bg-slate-700"
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

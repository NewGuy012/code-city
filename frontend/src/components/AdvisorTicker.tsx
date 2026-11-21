import { ChevronRight, Megaphone } from "lucide-react";
import { useEffect, useState } from "react";

import type { AdvisorAlert } from "../types/city";

interface AdvisorTickerProps {
  alerts: AdvisorAlert[];
  onFocusFile: (filePath: string) => void;
}

export function AdvisorTicker({ alerts, onFocusFile }: AdvisorTickerProps) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
  }, [alerts]);

  useEffect(() => {
    if (alerts.length <= 1) return;
    const timer = setInterval(() => {
      setIdx((prev) => (prev + 1) % alerts.length);
    }, 5500);
    return () => clearInterval(timer);
  }, [alerts.length]);

  if (alerts.length === 0) return null;
  const current = alerts[idx % alerts.length];

  const badgeTone =
    current.severity === "critical"
      ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
      : current.severity === "warn"
        ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
        : "border-sky-500/30 bg-sky-500/10 text-sky-200";

  return (
    <div
      data-testid="advisor-ticker"
      className="sim-panel flex max-w-2xl items-center gap-2.5 rounded-xl px-3 py-1.5 text-xs"
    >
      <span
        className={`flex items-center gap-1 rounded-lg border px-2 py-0.5 font-semibold ${badgeTone}`}
      >
        <Megaphone className="h-3 w-3" />
        City Advisor
      </span>

      <button
        type="button"
        disabled={!current.target_path}
        onClick={() => current.target_path && onFocusFile(current.target_path)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition hover:text-white disabled:cursor-default"
      >
        <span>{current.icon}</span>
        <span className="truncate font-semibold text-slate-100">{current.title}</span>
        <span className="hidden truncate text-slate-400 md:inline">— {current.detail}</span>
      </button>

      {alerts.length > 1 && (
        <button
          type="button"
          onClick={() => setIdx((prev) => (prev + 1) % alerts.length)}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          title="Next advisor alert"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

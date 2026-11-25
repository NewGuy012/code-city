import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

export const HUD_BASE_WIDTH = 1024;
export const HUD_BASE_HEIGHT = 640;
export const MIN_HUD_SCALE = 0.45;

export interface HudViewportMetrics {
  scale: number;
  vw: number;
  vh: number;
}

export function computeHudMetrics(width: number, height: number): HudViewportMetrics {
  if (width <= 0 || height <= 0) {
    return { scale: 1, vw: width || 1280, vh: height || 800 };
  }
  const raw = Math.max(
    MIN_HUD_SCALE,
    Math.min(1, width / HUD_BASE_WIDTH, height / HUD_BASE_HEIGHT),
  );
  const scale = raw >= 0.995 ? 1 : Math.floor(raw * 10000) / 10000;
  return {
    scale,
    vw: Math.floor(width / scale),
    vh: Math.floor(height / scale),
  };
}

export function getHudShellStyle(metrics: HudViewportMetrics): CSSProperties {
  if (metrics.scale >= 1) {
    return {
      "--hud-vw": "100vw",
      "--hud-vh": "100vh",
    } as CSSProperties;
  }
  return {
    width: `${(100 / metrics.scale).toFixed(4)}%`,
    height: `${(100 / metrics.scale).toFixed(4)}%`,
    transform: `scale(${metrics.scale})`,
    transformOrigin: "top left",
    "--hud-vw": `${metrics.vw}px`,
    "--hud-vh": `${metrics.vh}px`,
  } as CSSProperties;
}

export function useViewportHudMetrics(): HudViewportMetrics {
  const [metrics, setMetrics] = useState<HudViewportMetrics>(() =>
    typeof window !== "undefined"
      ? computeHudMetrics(window.innerWidth, window.innerHeight)
      : { scale: 1, vw: 1280, vh: 800 },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      const next = computeHudMetrics(window.innerWidth, window.innerHeight);
      setMetrics((prev) =>
        prev.scale === next.scale && prev.vw === next.vw && prev.vh === next.vh ? prev : next,
      );
    };
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  return metrics;
}

export type HudPopoverId =
  "repo" | "datamap" | "advisors" | "utilities" | "mayorMode" | "view" | null;

export const HUD_SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "WASD / Arrows", label: "Pan city" },
  { keys: "Q / E", label: "Yaw (Y-axis)" },
  { keys: "Alt / Opt + Drag", label: "Mouse yaw rotate" },
  { keys: "R / F", label: "Pitch (X-axis)" },
  { keys: "X", label: "Reset orientation" },
  { keys: "N / T", label: "North / Top-down" },
  { keys: "1 – 5", label: "Camera presets" },
  { keys: "M", label: "Toggle Radar" },
  { keys: "H", label: "Zen Mode (hide UI)" },
  { keys: "Esc", label: "Close / Inspect tool" },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type.toLowerCase();
    return (
      type !== "range" &&
      type !== "button" &&
      type !== "checkbox" &&
      type !== "radio" &&
      type !== "submit" &&
      type !== "reset"
    );
  }
  return tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Dismisses the active HUD popover on outside pointerdown (capture phase so
 * WebGL/2D canvas captures don't swallow clicks).
 */
export function usePopoverOutsideDismiss(openPopover: HudPopoverId, onClose: () => void): void {
  useEffect(() => {
    if (!openPopover) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest(`[data-popover-id="${openPopover}"]`) !== null
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose, openPopover]);
}

export function useCopyFeedback(delayMs = 1800): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard?.writeText(text).catch(() => {});
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, delayMs);
    },
    [delayMs],
  );

  return [copied, copy];
}

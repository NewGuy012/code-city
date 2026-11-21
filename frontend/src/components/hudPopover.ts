import { useCallback, useEffect, useRef, useState } from "react";

export type HudPopoverId =
  "repo" | "datamap" | "advisors" | "utilities" | "mayorMode" | "view" | null;

export const HUD_SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "WASD / Arrows", label: "Pan city" },
  { keys: "Q / E", label: "Rotate 90° / Orbit" },
  { keys: "R / F", label: "Pitch tilt" },
  { keys: "1 – 5", label: "Camera presets" },
  { keys: "M", label: "Toggle Radar" },
  { keys: "H", label: "Zen Mode (hide UI)" },
  { keys: "Esc", label: "Close / Inspect tool" },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
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

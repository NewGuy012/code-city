import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

interface ModalShellProps {
  open: boolean;
  testId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon: ReactNode;
  closeTitle?: string;
  maxWidthClass?: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function ModalShell({
  open,
  testId,
  title,
  subtitle,
  icon,
  closeTitle = "Close",
  maxWidthClass = "max-w-2xl",
  footer,
  onClose,
  children,
}: ModalShellProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, open]);

  if (!open) return null;

  const modalNode = (
    <div
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
    >
      <div
        className={`sim-panel flex max-h-[min(88%,calc(var(--hud-vh,100vh)-2rem))] w-full ${maxWidthClass} flex-col overflow-hidden rounded-3xl`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-700/70 px-6 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="shrink-0">{icon}</div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-bold text-white">{title}</h2>
              {subtitle && <p className="truncate text-xs text-slate-400">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            data-testid={`${testId}-close`}
            title={closeTitle}
            aria-label={closeTitle}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="shrink-0 cursor-pointer rounded-xl p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {children}

        {footer && (
          <div className="flex items-center justify-between border-t border-slate-800 px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  const portalRoot =
    typeof document !== "undefined" ? document.getElementById("codecity-modal-root") : null;
  return portalRoot ? createPortal(modalNode, portalRoot) : modalNode;
}

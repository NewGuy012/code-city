import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

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
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
    >
      <div
        className={`sim-panel flex max-h-[88vh] w-full ${maxWidthClass} flex-col overflow-hidden rounded-3xl`}
      >
        <div className="flex items-center justify-between border-b border-slate-700/70 px-6 py-4">
          <div className="flex items-center gap-2.5">
            {icon}
            <div>
              <h2 className="text-base font-bold text-white">{title}</h2>
              {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            title={closeTitle}
            onClick={onClose}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
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
}

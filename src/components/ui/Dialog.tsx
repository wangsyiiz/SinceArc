import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  width?: "sm" | "md";
}) {
  const { open, onClose, title, children, footer, icon, danger = false, width = "sm" } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="sc-dialog rounded-card! max-h-screen overflow-y-auto p-0 text-ink-1"
      style={{
        width: width === "md" ? "min(560px, calc(100vw - 48px))" : "min(420px, calc(100vw - 48px))",
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sc-selectable p-5">
        <div className="flex items-start gap-3">
          {icon && (
            <div
              className={
                danger
                  ? "grid size-8 shrink-0 place-items-center rounded-control border border-danger-1/20 bg-danger-1/10 text-danger-1"
                  : "grid size-8 shrink-0 place-items-center rounded-control border border-line-1 bg-surface-2 text-ink-2"
              }
            >
              {icon}
            </div>
          )}
          <h2 id={titleId} className="min-w-0 flex-1 text-title font-medium text-ink-1">
            {title}
          </h2>
        </div>
        <div className="mt-3 text-body text-ink-2">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
}

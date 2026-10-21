import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 破坏性操作的确认框。
 *
 * 立场（所有者定过）：不做回收站、不做宽限期 —— **授权即最终**。
 * 所以这里的责任是「把后果说准」，而不是给用户留后悔药：
 * 说清删什么、不删什么、能不能恢复。说清之后他点确认，就照办。
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "删除",
  cancelLabel = "取消",
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** 说明后果，建议逐条列清楚「会删什么 / 不会删什么」 */
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  return (
    <dialog
      ref={ref}
      // onCancel 是 <dialog> 自己的事件（Esc 触发），不能只靠 keydown —— 否则 Esc 会关掉
      // dialog 却不通知外面，状态就两边不一致了
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="sc-dialog sc-glass w-[min(420px,92vw)] rounded-[10px] border border-line-1/60 p-0 text-ink-1 backdrop:bg-black/45"
    >
      <div className="flex items-start gap-2.5 p-4">
        {danger && <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger-1" />}
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium text-ink-1">{title}</h2>
          <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">{body}</div>
          <div className="mt-3.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-[6px] px-3 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={cn(
                "rounded-[6px] px-3 py-1.5 text-[11px] transition-colors",
                danger
                  ? "bg-danger-1/15 text-danger-1 hover:bg-danger-1/25"
                  : "sc-row-active text-ink-1 hover:brightness-110",
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

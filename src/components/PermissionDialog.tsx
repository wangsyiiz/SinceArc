import { useEffect, useRef } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { PermissionRequest } from "@/types";
import { cn } from "@/lib/utils";

interface PermissionDialogProps {
  request: PermissionRequest;
  open: boolean;
  onDecide: (optionId: string) => void;
}

const TONE = {
  allow: {
    icon: ShieldCheck,
    className:
      "bg-accent-1 text-accent-ink hover:brightness-110 focus-visible:ring-accent-1/50",
  },
  always: {
    icon: ShieldCheck,
    className:
      "border border-line-2 bg-surface-2 text-ink-1 hover:bg-surface-3 focus-visible:ring-line-2",
  },
  reject: {
    icon: ShieldX,
    className:
      "border border-danger-1/30 bg-danger-1/10 text-danger-1 hover:bg-danger-1/15 focus-visible:ring-danger-1/40",
  },
} as const;

export function PermissionDialog({ request, open, onDecide }: PermissionDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sc-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onDecide("reject");
      }}
    >
      <div className="p-5">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-warn-1/25 bg-warn-1/10 text-warn-1">
            <ShieldAlert className="size-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-medium text-ink-1">{request.title}</div>
            {request.meta && (
              <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">{request.meta}</div>
            )}
          </div>
        </div>

        <p className="mt-3.5 text-[13px] leading-relaxed text-ink-2">{request.detail}</p>

        <div className="mt-5 flex flex-col gap-2">
          {request.options.map((opt, i) => {
            const tone = TONE[opt.tone];
            const Icon = tone.icon;
            return (
              <button
                key={opt.id}
                autoFocus={i === 0}
                onClick={() => onDecide(opt.id)}
                className={cn(
                  "flex items-center gap-2 rounded-[10px] px-3.5 py-2.5 text-left text-[13px] transition-colors outline-none focus-visible:ring-2",
                  tone.className,
                )}
              >
                <Icon className="size-4 shrink-0" />
                {opt.label}
                {i === 0 && (
                  <kbd className="ml-auto rounded border border-current/25 px-1.5 py-0.5 font-mono text-[10px] opacity-60">
                    Enter
                  </kbd>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-4 text-center text-[10.5px] text-ink-3">
          Esc 视为拒绝 · 该决定只对本次请求生效
        </div>
      </div>
    </dialog>
  );
}

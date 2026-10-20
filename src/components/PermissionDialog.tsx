import { useEffect, useRef } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { PermissionRequest, Player } from "@/types";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";

interface PermissionDialogProps {
  request: PermissionRequest;
  player?: Player;
  open: boolean;
  onDecide: (optionId: string) => void;
}

const TONE = {
  allow: {
    icon: ShieldCheck,
    className:
      "bg-accent-1 text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:brightness-110 focus-visible:ring-accent-1/50",
  },
  always: {
    icon: ShieldCheck,
    className: "sc-control bg-surface-3/50 text-ink-1 hover:bg-surface-3/85 focus-visible:ring-line-2",
  },
  reject: {
    icon: ShieldX,
    className:
      "border border-danger-1/25 bg-danger-1/[0.09] text-danger-1 hover:bg-danger-1/[0.14] focus-visible:ring-danger-1/40",
  },
} as const;

export function PermissionDialog({ request, player, open, onDecide }: PermissionDialogProps) {
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
          <div className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-warn-1/20 bg-warn-1/[0.09] text-warn-1">
            <ShieldAlert className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-ink-1">{request.title}</span>
              {player && (
                <span className="flex items-center gap-1 rounded-full bg-surface-3/45 py-0.5 pl-0.5 pr-2">
                  <PlayerAvatar player={player} size={14} />
                  <span className="text-[10px]" style={{ color: player.color }}>
                    {player.name}
                  </span>
                </span>
              )}
            </div>
            {request.meta && (
              <div className="mt-0.5 font-mono text-[10px] text-ink-3">{request.meta}</div>
            )}
          </div>
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{request.detail}</p>

        <div className="mt-4 flex flex-col gap-1.5">
          {request.options.map((opt, i) => {
            const tone = TONE[opt.tone];
            const Icon = tone.icon;
            return (
              <button
                key={opt.id}
                autoFocus={i === 0}
                onClick={() => onDecide(opt.id)}
                className={cn(
                  "flex items-center gap-2 rounded-[8px] px-3 py-2 text-left text-[12.5px] transition-colors outline-none focus-visible:ring-2",
                  tone.className,
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {opt.label}
                {i === 0 && (
                  <kbd className="ml-auto rounded border border-current/25 px-1.5 py-0.5 font-mono text-[9.5px] opacity-60">
                    Enter
                  </kbd>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3.5 text-center text-[10px] text-ink-3">
          Esc 视为拒绝 · 该决定只对本次请求生效
        </div>
      </div>
    </dialog>
  );
}

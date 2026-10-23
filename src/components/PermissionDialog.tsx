import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { PermissionRequest, Player } from "@/types";
import { PlayerAvatar } from "./PlayerAvatar";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

interface PermissionDialogProps {
  request: PermissionRequest;
  player?: Player;
  open: boolean;
  onDecide: (optionId: string) => void;
  /** Esc / 关闭：由上层按 kind 找拒绝项，不能在对话框里硬编码 optionId */
  onCancel: () => void;
  /** 队列里还剩多少条（含当前这条） */
  queued?: number;
}

const TONE = {
  allow: { icon: ShieldCheck, variant: "primary" as const, danger: false },
  always: { icon: ShieldCheck, variant: "secondary" as const, danger: false },
  reject: { icon: ShieldX, variant: "ghost" as const, danger: true },
};

export function PermissionDialog({
  request,
  player,
  open,
  onDecide,
  onCancel,
  queued = 1,
}: PermissionDialogProps) {
  const hasAlways = request.options.some((option) => option.tone === "always");

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={request.title}
      width="md"
      icon={<ShieldAlert className="size-4 text-warn-1" />}
    >
      {(queued > 1 || player || request.meta) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {queued > 1 && <Badge status="untested" label={`还有 ${queued - 1} 个`} compact />}
          {player && (
            <span className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2">
              <PlayerAvatar player={player} size={14} />
              <span className="text-caption text-ink-2">{player.name}</span>
            </span>
          )}
          {request.meta && <span className="font-mono text-caption text-ink-3">{request.meta}</span>}
        </div>
      )}

      <p>{request.detail}</p>

      <div className="mt-4 flex flex-col gap-1.5">
        {request.options.map((option, index) => {
          const tone = TONE[option.tone];
          const Icon = tone.icon;
          return (
            <Button
              key={option.id}
              autoFocus={index === 0}
              variant={tone.variant}
              danger={tone.danger}
              className="w-full justify-start px-3 text-left"
              onClick={() => onDecide(option.id)}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {index === 0 && (
                <kbd className="ml-auto rounded-mark border border-line-1 px-1.5 py-0.5 font-mono text-caption text-ink-3">
                  Enter
                </kbd>
              )}
            </Button>
          );
        })}
      </div>

      <div className="mt-3 text-center text-caption text-ink-3">
        Esc 视为拒绝 ·{" "}
        {hasAlways ? "选择「始终允许」会对后续同类请求生效" : "该决定只对本次请求生效"}
      </div>
    </Dialog>
  );
}

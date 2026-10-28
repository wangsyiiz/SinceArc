import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PermissionRequest, Player } from "@/types";
import { permissionKindKey } from "@/lib/permission-kind";
import { localizeText } from "@/lib/i18n-text";
import { PlayerAvatar } from "./PlayerAvatar";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

interface PermissionDialogProps {
  request: PermissionRequest;
  player?: Player;
  open: boolean;
  onDecide: (optionId: string, note: string | null) => void;
  /** 先登记「本轮同类」策略，成功后再沿用 onDecide 应答本条。 */
  onAllowTurn?: () => Promise<void>;
  /** 当前轮已放行的 kind；命中的请求若没有 allow 项，弹窗要说明为什么没自动答。 */
  turnPolicyKind?: string | null;
  /** Esc / 关闭：由上层按 kind 找拒绝项，不能在对话框里硬编码 optionId */
  onCancel: (note: string | null) => void;
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
  onAllowTurn,
  turnPolicyKind = null,
  onCancel,
  queued = 1,
}: PermissionDialogProps) {
  const { t } = useTranslation();
  const hasAlways = request.options.some((option) => option.tone === "always");
  const hasReject = request.options.some((option) => option.tone === "reject");
  const allowOption = request.options.find(
    (option) => option.tone === "allow" || option.tone === "always",
  );
  const expired = request.expiredReason !== undefined;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [allowTurnBusy, setAllowTurnBusy] = useState(false);
  const [allowTurnError, setAllowTurnError] = useState<string | null>(null);
  const noteForDecision = note.trim().length > 0 ? note.trim() : null;
  const policyMissed =
    turnPolicyKind !== null && turnPolicyKind === request.kind && !allowOption && !expired
      ? t("permission.skipped.noAuto")
      : null;
  const skippedReason = policyMissed ?? request.autoSkippedReason ?? null;

  useEffect(() => {
    setNoteOpen(false);
    setNote("");
    setAllowTurnBusy(false);
    setAllowTurnError(null);
  }, [request.id]);

  const allowTurn = async () => {
    if (!allowOption || !onAllowTurn) return;
    setAllowTurnBusy(true);
    setAllowTurnError(null);
    try {
      await onAllowTurn();
      onDecide(allowOption.id, noteForDecision);
    } catch (e) {
      const message =
        (e as { msg?: string })?.msg ?? (e instanceof Error ? e.message : String(e));
      setAllowTurnError(localizeText(message, t));
    } finally {
      setAllowTurnBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => onCancel(noteForDecision)}
      title={localizeText(request.title, t)}
      titleAdornment={
        <span className="shrink-0 rounded-mark border border-line-1 px-1 text-caption text-ink-3">
          {t(permissionKindKey(request.kind))}
        </span>
      }
      width="md"
      icon={<ShieldAlert className="size-4 text-warn-1" />}
    >
      {(queued > 1 || player || request.meta) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {queued > 1 && (
            <Badge
              status="untested"
              label={t("permission.queued", { count: queued - 1 })}
              compact
            />
          )}
          {player && (
            <span className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2">
              <PlayerAvatar player={player} size={14} />
              <span className="text-caption text-ink-2">{localizeText(player.name, t)}</span>
            </span>
          )}
          {request.meta && <span className="font-mono text-caption text-ink-3">{request.meta}</span>}
        </div>
      )}

      {expired && (
        <div className="mb-3 rounded-control border border-line-1 bg-surface-2 px-2.5 py-1.5 text-small text-ink-3">
          {t("permission.expired", {
            reason: localizeText(request.expiredReason ?? "", t),
          })}
        </div>
      )}

      {skippedReason && (
        <div className="mb-3 rounded-control border border-line-1 bg-surface-2 px-2.5 py-1.5 text-small text-ink-3">
          {localizeText(skippedReason, t)}
        </div>
      )}

      <p>{localizeText(request.detail, t)}</p>

      <div className="mt-4 flex flex-col gap-1.5">
        {request.options.map((option, index) => {
          const tone = TONE[option.tone];
          const Icon = tone.icon;
          return (
            <Button
              key={option.id}
              autoFocus={index === 0 && !expired}
              variant={tone.variant}
              danger={tone.danger}
              disabled={expired}
              className="w-full justify-start px-3 text-left"
              onClick={() => onDecide(option.id, noteForDecision)}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {index === 0 && !expired && (
                <kbd className="ml-auto rounded-mark border border-line-1 px-1.5 py-0.5 font-mono text-caption text-ink-3">
                  Enter
                </kbd>
              )}
            </Button>
          );
        })}
      </div>

      {onAllowTurn && request.kind && allowOption && !expired && (
        <div className="mt-2">
          <Button
            variant="secondary"
            disabled={allowTurnBusy}
            className="w-full justify-start px-3 text-left"
            onClick={() => void allowTurn()}
          >
            <ShieldCheck className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {t("permission.allowTurn", { kind: t(permissionKindKey(request.kind)) })}
            </span>
          </Button>
          {allowTurnError && (
            <div className="mt-1 text-small text-danger-1" role="alert">
              {t("permission.allowTurnFailed", { msg: allowTurnError })}
            </div>
          )}
        </div>
      )}

      {hasReject && (
        <div className="mt-2">
          <button
            type="button"
            className="text-small text-ink-3 transition-colors hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-45"
            aria-expanded={noteOpen}
            disabled={expired}
            onClick={() => setNoteOpen((open) => !open)}
          >
            {noteOpen ? t("permission.note.hide") : t("permission.note.show")}
          </button>
          {noteOpen && (
            <input
              type="text"
              value={note}
              disabled={expired}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("permission.note.placeholder")}
              aria-label={t("permission.note.aria")}
              className="mt-1.5 h-8 w-full rounded-control border border-line-1 bg-surface-1 px-2 text-small text-ink-1 placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 disabled:cursor-not-allowed disabled:opacity-45"
            />
          )}
        </div>
      )}

      <div className="mt-3 text-center text-caption text-ink-3">
        {expired
          ? t("permission.expired.footer")
          : t(hasAlways ? "permission.footer.escAlways" : "permission.footer.escOnce")}
      </div>
    </Dialog>
  );
}

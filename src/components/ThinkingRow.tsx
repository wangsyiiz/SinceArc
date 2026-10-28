import { FileLock, Waypoints } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { localizeText, translateKey } from "@/lib/i18n-text";
import { activityRowView } from "@/lib/activity-row";
import type { Activity, Player } from "@/types";
import { PlayerAvatar } from "./PlayerAvatar";
import { Button } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";

interface ThinkingRowProps {
  player: Player;
  activity: Activity;
  onOpenTrace: () => void;
  /** 该动作是写类操作，但写入锁被别的玩家占着 */
  queued?: { holder: string } | null;
  /** 该 agent 自己的写锁；由 App 查 `session.locks[acpSid]` 后传入，组件不查表 */
  lock?: { title: string; count: number };
}

export function ThinkingRow({ player, activity, onOpenTrace, queued, lock }: ThinkingRowProps) {
  const { t } = useTranslation();
  // 只有 running 分支走 §21 的四段布局；已结束的历史行保持原样。
  const view = activity.status === "running" ? activityRowView(activity, lock) : null;

  return (
    <div className="flex gap-2.5">
      <PlayerAvatar player={player} size={22} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-caption font-medium" style={{ color: player.color }}>
            {localizeText(player.name, t)}
          </span>
          <span className="font-mono text-micro text-ink-3">{activity.at}</span>
        </div>

        <div className="flex items-center gap-2 rounded-card border border-dashed border-line-1/70 bg-surface-2/25 px-3 py-2">
          {view ? (
            <>
              <span className="shrink-0 text-caption text-ink-3">
                {translateKey(t, view.labelKey)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-baseline gap-2">
                  {queued && (
                    <span className="min-w-0 flex-1 truncate text-caption text-ink-3">
                      {t("thinking.waiting", { holder: queued.holder })}
                    </span>
                  )}
                  {!queued && view.title && (
                    <span className="min-w-0 flex-1 truncate text-caption font-medium text-ink-2">
                      {localizeText(view.title, t)}
                    </span>
                  )}
                  {view.detail && (
                    <span className="min-w-0 truncate font-mono text-micro text-ink-3">
                      {localizeText(view.detail, t)}
                    </span>
                  )}
                </span>
                {view.bodyLine && (
                  <span className="min-w-0 truncate font-mono text-micro text-ink-3">
                    {localizeText(view.bodyLine, t)}
                  </span>
                )}
              </span>
              {view.lock && (
                <Tooltip
                  label={translateKey(t, view.lock.tooltipKey, { path: view.lock.path })}
                >
                  <span className="flex shrink-0 items-center gap-0.5 text-ink-3">
                    <FileLock className="size-3" />
                    {view.lock.countText && (
                      <span className="text-micro">{view.lock.countText}</span>
                    )}
                  </span>
                </Tooltip>
              )}
              <Tooltip label={t("thinking.locate")}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenTrace}
                  className="h-auto shrink-0 gap-1 rounded-mark px-1.5 py-1 text-caption"
                  style={{ color: player.color }}
                >
                  <Waypoints className="size-3" />
                  {t("thinking.trace")}
                </Button>
              </Tooltip>
            </>
          ) : (
            <>
              <span className="flex items-end gap-1">
                <span
                  className="sc-dot size-1 rounded-full"
                  style={{ background: player.color }}
                />
                <span
                  className="sc-dot size-1 rounded-full"
                  style={{ background: player.color }}
                />
                <span
                  className="sc-dot size-1 rounded-full"
                  style={{ background: player.color }}
                />
              </span>
              <span className={cn("truncate text-caption", queued ? "text-ink-3" : "text-ink-2")}>
                {queued
                  ? t("thinking.waiting", { holder: queued.holder })
                  : localizeText(activity.title, t)}
              </span>
              {activity.detail && (
                <span className="min-w-0 truncate font-mono text-micro text-ink-3">
                  {localizeText(activity.detail, t)}
                </span>
              )}

              <Tooltip label={t("thinking.locate")}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenTrace}
                  className="ml-auto h-auto shrink-0 gap-1 rounded-mark px-1.5 py-1 text-caption"
                  style={{ color: player.color }}
                >
                  <Waypoints className="size-3" />
                  {t("thinking.trace")}
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

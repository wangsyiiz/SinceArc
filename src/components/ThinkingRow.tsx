import { Waypoints } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { localizeText } from "@/lib/i18n-text";
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
}

export function ThinkingRow({ player, activity, onOpenTrace, queued }: ThinkingRowProps) {
  const { t } = useTranslation();

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
          <span className="flex items-end gap-1">
            <span className="sc-dot size-1 rounded-full" style={{ background: player.color }} />
            <span className="sc-dot size-1 rounded-full" style={{ background: player.color }} />
            <span className="sc-dot size-1 rounded-full" style={{ background: player.color }} />
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
        </div>
      </div>
    </div>
  );
}

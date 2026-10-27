import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StorageStatsDto } from "@/lib/ipc";
import { Tooltip } from "./ui/Tooltip";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

export function StorageNotice({ stats }: { stats: StorageStatsDto | null }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  if (!stats || !stats.over || dismissed) return null;

  const days =
    stats.oldestAt === null
      ? null
      : Math.max(0, Math.floor((Date.now() - stats.oldestAt) / DAY_MS));

  return (
    <aside
      role="status"
      aria-live="polite"
      className="rounded-card border border-line-1 bg-surface-1 px-3 py-2 text-caption text-ink-2"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {stats.reasons.includes("count") && (
            <p>
              {t("storage.count", {
                used: formatCount(stats.traceCount),
                threshold: formatCount(stats.thresholdCount),
              })}
            </p>
          )}
          {stats.reasons.includes("age") && days !== null && (
            <p>
              {t("storage.age", { days, threshold: stats.thresholdDays })}
            </p>
          )}
          {/* 两个原因同时命中时这句只说一次 —— 重复两遍像复读机，也把气泡撑高。 */}
          <p>{t("storage.retained")}</p>
        </div>
        <Tooltip label={t("storage.dismiss")}>
          <button
            type="button"
            aria-label={t("storage.dismiss")}
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded-mark p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

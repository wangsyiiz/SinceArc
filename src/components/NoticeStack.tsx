import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { localizeText } from "@/lib/i18n-text";
import type { NoticeSeverity, UiNotice } from "@/lib/notice-inbox";
import { cn } from "@/lib/utils";

const TONE: Record<
  NoticeSeverity,
  { icon: typeof Info; iconClass: string; frameClass: string }
> = {
  info: {
    icon: Info,
    iconClass: "text-ink-2",
    frameClass: "border-line-1/70 bg-surface-1",
  },
  warning: {
    icon: AlertTriangle,
    iconClass: "text-warn-1",
    frameClass: "border-warn-1/45 bg-surface-1",
  },
  error: {
    icon: AlertCircle,
    iconClass: "text-danger-1",
    frameClass: "border-danger-1/45 bg-surface-1",
  },
};

export function NoticeStack({
  notices,
  onDismiss,
}: {
  notices: UiNotice[];
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (notices.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-live="polite">
      {notices.map((notice) => {
        const tone = TONE[notice.severity];
        const Icon = tone.icon;
        return (
          <div
            key={notice.id}
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-card border px-3 py-2 text-caption text-ink-2",
              tone.frameClass,
            )}
          >
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone.iconClass)} aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-ink-1">
                  {localizeText(notice.title, t)}
                </span>
                {notice.count > 1 && (
                  <span className="shrink-0 font-mono text-micro text-ink-3">×{notice.count}</span>
                )}
              </div>
              {notice.description && (
                <p className="whitespace-pre-wrap break-words text-ink-2">
                  {localizeText(notice.description, t)}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label={t("notice.dismiss")}
              onClick={() => onDismiss(notice.id)}
              className="shrink-0 rounded-mark p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

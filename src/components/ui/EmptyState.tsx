import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "@/lib/utils";

const TITLE_TONE = {
  default: "text-ink-1",
  warn: "text-warn-1",
  danger: "text-danger-1",
} as const;

export function EmptyState(props: {
  kind?: "empty" | "loading" | "error";
  /** 标题的语气：连接类失败用 warn（环境问题），数据损坏/破坏性后果用 danger。默认跟 kind 走。 */
  tone?: "default" | "warn" | "danger";
  title: string;
  description?: string;
  action?: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
  compact?: boolean;
  icon?: ReactNode;
}) {
  const {
    kind = "empty",
    tone: toneProp,
    title,
    description,
    action,
    retryLabel = "重试",
    onRetry,
    compact = false,
    icon,
  } = props;
  const [showLoading, setShowLoading] = useState(false);
  const tone = toneProp ?? (kind === "error" ? "danger" : "default");

  useEffect(() => {
    if (kind !== "loading") {
      setShowLoading(false);
      return;
    }
    setShowLoading(false);
    const timer = window.setTimeout(() => setShowLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [kind]);

  if (kind === "loading") {
    return (
      <div
        role="status"
        aria-label={title}
        className={
          compact
            ? "flex flex-col items-center gap-2 py-4"
            : "flex h-full flex-col items-center justify-center gap-3 py-6"
        }
      >
        {showLoading && (
          <div className="flex w-full max-w-sm flex-col items-center gap-2">
            <span className="h-3 w-56 rounded-control bg-surface-2" />
            <span className="h-3 w-72 rounded-control bg-surface-2" />
            <span className="h-3 w-40 rounded-control bg-surface-2" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={
        compact
          ? "flex flex-col items-center justify-center gap-2 px-4 py-4 text-center"
          : "flex h-full flex-col items-center justify-center gap-3 px-6 py-6 text-center"
      }
    >
      {icon}
      <h2 className={cn("text-title font-medium", TITLE_TONE[tone])}>{title}</h2>
      {description && (
        <p className="max-w-md text-body text-ink-3">{description}</p>
      )}
      {kind === "error" && onRetry && (
        <Button size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
      {kind === "empty" && action}
    </div>
  );
}

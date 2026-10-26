import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button";

export function EmptyState(props: {
  kind?: "empty" | "loading" | "error";
  heading: string;
  description?: string;
  action?: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
  compact?: boolean;
  icon?: ReactNode;
}) {
  const {
    kind = "empty",
    heading,
    description,
    action,
    retryLabel = "重试",
    onRetry,
    compact = false,
    icon,
  } = props;
  const [showLoading, setShowLoading] = useState(false);

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
        aria-label={heading}
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
      <h2 className={kind === "error" ? "text-title font-medium text-danger-1" : "text-title font-medium text-ink-1"}>{heading}</h2>
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

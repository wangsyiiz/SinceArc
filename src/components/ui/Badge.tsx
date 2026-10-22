import { cn } from "@/lib/utils";

export type AgentStatus = "connected" | "connecting" | "error" | "untested";

const DOT: Record<AgentStatus, string> = {
  connected: "bg-ok-1",
  connecting: "bg-accent-1",
  error: "bg-danger-1",
  untested: "border border-ink-3 bg-transparent",
};

export function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT[status],
        status === "connecting" && "sc-status-pulse",
      )}
    />
  );
}

export function Badge(props: { status: AgentStatus; label: string; compact?: boolean }) {
  const { status, label, compact = false } = props;
  return (
    <span
      className={cn(
        "inline-flex h-4.5 items-center rounded-mark border border-line-1 bg-surface-1 text-caption",
        compact ? "gap-1 px-1.5" : "gap-1.5 px-2",
        status === "connected" && "text-ink-2",
        status === "connecting" && "text-ink-2",
        status === "error" && "text-danger-1",
        status === "untested" && "text-ink-3",
      )}
    >
      <StatusDot status={status} />
      <span className="truncate">{label}</span>
    </span>
  );
}

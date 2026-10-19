import { useState } from "react";
import {
  Check,
  ChevronRight,
  FileText,
  Loader2,
  PencilLine,
  Play,
  Search,
  Wrench,
  X,
} from "lucide-react";
import type { ToolCall, ToolKind } from "@/types";
import { cn } from "@/lib/utils";

const ICONS: Record<ToolKind, typeof FileText> = {
  read: FileText,
  edit: PencilLine,
  execute: Play,
  search: Search,
  other: Wrench,
};

function StatusMark({ status }: { status: ToolCall["status"] }) {
  if (status === "ok") return <Check className="size-3.5 text-ok-1" />;
  if (status === "error") return <X className="size-3.5 text-danger-1" />;
  if (status === "running")
    return <Loader2 className="size-3.5 animate-spin text-accent-1" />;
  return <span className="size-1.5 rounded-full border border-ink-3" />;
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[call.kind];
  const hasDetail = Boolean(call.detail);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border bg-surface-1 transition-colors",
        call.status === "running" ? "border-accent-1/30" : "border-line-1",
      )}
    >
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2 text-left",
          hasDetail && "hover:bg-surface-2",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-ink-3 transition-transform",
            open && "rotate-90",
            !hasDetail && "opacity-0",
          )}
        />
        <Icon className="size-3.5 shrink-0 text-ink-2" />
        <span className="truncate text-[12.5px] text-ink-1">{call.title}</span>
        {call.meta && (
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
            {call.meta}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <StatusMark status={call.status} />
        </span>
      </button>

      {open && hasDetail && (
        <pre className="max-h-72 overflow-auto border-t border-line-1 bg-surface-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {call.detail}
        </pre>
      )}
    </div>
  );
}

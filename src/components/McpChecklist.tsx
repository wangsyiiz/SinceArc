import { Check } from "lucide-react";
import type { AgentCaps } from "@/lib/ipc";
import type { McpCatalogEntryDto } from "@/lib/ipc";
import { entryKind, transportSupportNote } from "@/lib/mcp-display";
import { cn } from "@/lib/utils";
import { Tooltip } from "./ui/Tooltip";

export function McpCheck({
  checked,
  disabled = false,
}: {
  checked: boolean;
  disabled?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-mark border transition-colors",
        checked
          ? "border-accent-1 bg-accent-1 text-accent-ink"
          : "border-line-2 bg-surface-1 text-transparent",
        disabled && "opacity-45",
      )}
    >
      <Check className="size-3" />
    </span>
  );
}

export function McpServerChecklist({
  entries,
  selected,
  onToggle,
  caps = null,
  disabled = false,
  emptyText = "目录里还没有条目。",
}: {
  entries: McpCatalogEntryDto[];
  selected: readonly string[];
  onToggle: (name: string, next: boolean) => void;
  caps?: AgentCaps | null;
  disabled?: boolean;
  emptyText?: string;
}) {
  if (entries.length === 0) {
    return <p className="px-1 py-1 text-caption text-ink-3">{emptyText}</p>;
  }

  return (
    <div className="space-y-0.5">
      {entries.map((entry) => {
        const checked = selected.includes(entry.name);
        const kind = entryKind(entry);
        const note = transportSupportNote(kind, caps);
        const name = (
          <span className="min-w-0 flex-1 truncate text-ui-tight text-ink-1">{entry.name}</span>
        );
        return (
          <button
            key={entry.name}
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onToggle(entry.name, !checked)}
            className={cn(
              "flex w-full items-center gap-2 rounded-mark px-1.5 py-1 text-left transition-colors",
              "hover:bg-surface-3/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <McpCheck checked={checked} disabled={disabled} />
            {entry.name.length > 24 && !disabled ? (
              <Tooltip label={entry.name}>{name}</Tooltip>
            ) : (
              name
            )}
            <span className="shrink-0 font-mono text-micro text-ink-3">{kind}</span>
            {note && <span className="shrink-0 text-micro text-warn-1">{note}</span>}
          </button>
        );
      })}
    </div>
  );
}

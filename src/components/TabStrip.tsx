import { FolderGit2, GitPullRequest, MessageSquare, X } from "lucide-react";
import type { Tab } from "@/types";
import { cn } from "@/lib/utils";

const ICON = {
  session: MessageSquare,
  repo: FolderGit2,
  pr: GitPullRequest,
} as const;

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  badgeOf?: (t: Tab) => string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabStrip({ tabs, activeId, badgeOf, onSelect, onClose }: TabStripProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line-1/60 px-1.5">
      {tabs.map((t) => {
        const Icon = ICON[t.kind];
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              "group flex h-8 min-w-0 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-t-[8px] border-x border-t px-2.5 text-[11.5px] transition-colors",
              active
                ? "border-line-1/70 bg-white/[0.055] text-ink-1"
                : "border-transparent text-ink-3 hover:bg-white/[0.03] hover:text-ink-2",
            )}
            title={t.subtitle ?? t.title}
          >
            <Icon className={cn("size-3 shrink-0", active ? "text-ink-2" : "text-ink-3")} />
            <span className="truncate">{t.title}</span>
            {badgeOf?.(t) && (
              <span
                className={cn("size-1.5 shrink-0 rounded-full", activeId !== t.id && "animate-pulse")}
                style={{ background: badgeOf(t) ?? undefined }}
              />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              className={cn(
                "ml-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] transition-colors hover:bg-white/[0.1]",
                active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
              )}
              title="关闭"
            >
              <X className="size-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

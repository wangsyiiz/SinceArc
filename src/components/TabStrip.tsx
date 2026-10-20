import { FolderGit2, GitPullRequest, MessageSquare, Settings2, X } from "lucide-react";
import type { Tab } from "@/types";
import { cn } from "@/lib/utils";

const ICON = {
  session: MessageSquare,
  repo: FolderGit2,
  pr: GitPullRequest,
  settings: Settings2,
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
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line-1/60">
      {tabs.map((t) => {
        const Icon = ICON[t.kind];
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={cn(
              "group flex h-full min-w-0 max-w-[220px] cursor-pointer items-center gap-1.5 border-r border-line-1/40 px-3 text-[11.5px] transition-colors",
              active
                ? "bg-surface-3/50 text-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
                : "text-ink-3 hover:bg-surface-2/50 hover:text-ink-2",
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
                "ml-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] transition-colors hover:bg-surface-3",
                active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
              )}
              title="关闭"
            >
              <X className="size-2.5" />
            </button>
          </button>
        );
      })}
    </div>
  );
}

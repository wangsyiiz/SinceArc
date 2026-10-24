import { FolderGit2, GitPullRequest, MessageSquare, Settings2, X } from "lucide-react";
import type { Tab } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui/Button";

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
              "group flex h-full min-w-0 max-w-55 cursor-pointer items-center gap-1.5 border-r border-line-1/40 px-3 text-ui-tight transition-colors",
              active
                ? "sc-row-active text-ink-1"
                : "text-ink-3 hover:bg-surface-3 hover:text-ink-1",
            )}
            title={t.subtitle}
          >
            <Icon className={cn("size-3 shrink-0", active ? "text-ink-2" : "text-ink-3")} />
            <span className="truncate">{t.title}</span>
            {badgeOf?.(t) && (
              <span
                className={cn("size-1.5 shrink-0 rounded-full", activeId !== t.id && "animate-pulse")}
                style={{ background: badgeOf(t) ?? undefined }}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              aria-label="关闭"
              title="关闭"
              className={cn(
                "ml-0.5 size-4 shrink-0 gap-0 rounded-mark p-0",
                active
                  ? "opacity-60 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-60 hover:opacity-100",
              )}
            >
              <X className="size-2.5" />
            </Button>
          </button>
        );
      })}
    </div>
  );
}

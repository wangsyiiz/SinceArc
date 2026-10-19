import { useMemo } from "react";
import { Plus, Settings2, Terminal } from "lucide-react";
import type { AgentProfile, SessionSummary } from "@/types";
import { cn } from "@/lib/utils";

interface SidebarProps {
  sessions: SessionSummary[];
  activeId: string;
  profiles: AgentProfile[];
  activeProfileId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSelectProfile: (id: string) => void;
}

const GROUPS: SessionSummary["group"][] = ["今天", "昨天", "更早"];

export function Sidebar({
  sessions,
  activeId,
  profiles,
  activeProfileId,
  onSelect,
  onNew,
  onSelectProfile,
}: SidebarProps) {
  const grouped = useMemo(() => {
    return GROUPS.map((g) => ({
      group: g,
      items: sessions.filter((s) => s.group === g),
    })).filter((x) => x.items.length > 0);
  }, [sessions]);

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-line-1 bg-surface-1">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="grid size-7 place-items-center rounded-lg bg-accent-1/15 text-accent-1">
          <span className="text-[15px] leading-none">◇</span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold tracking-tight">
            SinceArc
          </div>
          <div className="truncate text-[10.5px] text-ink-3">ACP Client</div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-[10px] border border-line-1 bg-surface-2 px-3 py-2 text-[13px] text-ink-1 transition-colors hover:border-line-2 hover:bg-surface-3"
        >
          <Plus className="size-4 text-ink-2" />
          新建会话
          <kbd className="ml-auto rounded border border-line-1 bg-surface-0 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
            ⌘N
          </kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {grouped.map(({ group, items }) => (
          <div key={group} className="mb-1">
            <div className="px-2 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-ink-3">
              {group}
            </div>
            {items.map((s) => {
              const active = s.id === activeId;
              return (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className={cn(
                    "group mb-0.5 flex w-full flex-col gap-0.5 rounded-[9px] px-2.5 py-2 text-left transition-colors",
                    active
                      ? "bg-surface-3"
                      : "hover:bg-surface-2",
                  )}
                >
                  <span
                    className={cn(
                      "truncate text-[12.5px]",
                      active ? "text-ink-1" : "text-ink-2 group-hover:text-ink-1",
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
                    <span className="truncate font-mono">{s.cwd}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-t border-line-1 p-2">
        <div className="mb-1 px-2 text-[10.5px] text-ink-3">Agent</div>
        <div className="flex flex-col gap-0.5">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelectProfile(p.id)}
              className={cn(
                "flex items-center gap-2 rounded-[9px] px-2.5 py-2 text-left transition-colors",
                p.id === activeProfileId ? "bg-surface-2" : "hover:bg-surface-2/60",
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  p.connected ? "bg-ok-1" : "bg-ink-3",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-ink-1">{p.name}</span>
                <span className="block truncate font-mono text-[10px] text-ink-3">
                  {p.detail}
                </span>
              </span>
              {p.launch === "wsl" && <Terminal className="size-3.5 shrink-0 text-ink-3" />}
            </button>
          ))}
        </div>
        <button className="mt-1 flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-[12px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2">
          <Settings2 className="size-3.5" />
          设置
        </button>
        {activeProfile && !activeProfile.connected && (
          <div className="px-2.5 pb-1 text-[10.5px] text-warn-1">未连接</div>
        )}
      </div>
    </aside>
  );
}

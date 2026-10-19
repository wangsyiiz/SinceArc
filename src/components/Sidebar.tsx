import { useMemo } from "react";
import { Plus, Settings2, Terminal } from "lucide-react";
import type { AgentProfile, Player, SessionSummary } from "@/types";
import { cn } from "@/lib/utils";

interface SidebarProps {
  sessions: SessionSummary[];
  activeId: string;
  profiles: AgentProfile[];
  players: Player[];
  activeProfileId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSelectProfile: (id: string) => void;
  onOpenSettings: () => void;
}

const GROUPS: SessionSummary["group"][] = ["今天", "昨天", "更早"];

export function Sidebar({
  sessions,
  activeId,
  profiles,
  players,
  activeProfileId,
  onSelect,
  onNew,
  onSelectProfile,
  onOpenSettings,
}: SidebarProps) {
  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({ group: g, items: sessions.filter((s) => s.group === g) })).filter(
        (x) => x.items.length > 0,
      ),
    [sessions],
  );

  return (
    <aside className="sc-pane flex h-full w-[260px] shrink-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 pt-3.5 pb-2.5">
        <div className="grid size-6 place-items-center rounded-[6px] bg-accent-1/12 text-[13px] leading-none text-accent-1">
          ◇
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold tracking-tight">SinceArc</div>
          <div className="truncate text-[10px] text-ink-3">ACP Client</div>
        </div>
      </div>

      <div className="px-2.5 pb-2">
        <button
          onClick={onNew}
          className="sc-control flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-[12.5px] text-ink-1 transition-colors hover:bg-white/[0.09]"
        >
          <Plus className="size-3.5 text-ink-2" />
          新建会话
          <kbd className="ml-auto rounded border border-line-1/70 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
            Ctrl N
          </kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {grouped.map(({ group, items }) => (
          <div key={group} className="mb-0.5">
            <div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-3">
              {group}
            </div>
            {items.map((s) => {
              const active = s.id === activeId;
              return (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className={cn(
                    "group mb-0.5 flex w-full flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left transition-colors",
                    active ? "bg-white/[0.07] shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]" : "hover:bg-white/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "truncate text-[12px]",
                      active ? "text-ink-1" : "text-ink-2 group-hover:text-ink-1",
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="flex items-center gap-1">
                    {s.playerIds.slice(0, 3).map((pid) => {
                      const pl = players.find((x) => x.id === pid);
                      return pl ? (
                        <span
                          key={pid}
                          className="size-1.5 rounded-full"
                          style={{ background: pl.color }}
                          title={pl.name}
                        />
                      ) : null;
                    })}
                    <span className="truncate font-mono text-[10px] text-ink-3">{s.cwd}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-t border-line-1/80 p-2">
        <div className="mb-1 px-1.5 text-[10px] text-ink-3">Agent</div>
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelectProfile(p.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors",
              p.id === activeProfileId ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
            )}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", p.connected ? "bg-ok-1" : "bg-ink-3")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11.5px] text-ink-1">{p.name}</span>
              <span className="block truncate font-mono text-[9.5px] text-ink-3">{p.detail}</span>
            </span>
            {p.launch === "wsl" && <Terminal className="size-3 shrink-0 text-ink-3" />}
          </button>
        ))}
        <button onClick={onOpenSettings} className="mt-0.5 flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-[11.5px] text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink-2">
          <Settings2 className="size-3.5" />
          设置
        </button>
      </div>
    </aside>
  );
}

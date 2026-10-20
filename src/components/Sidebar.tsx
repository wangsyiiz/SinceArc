import { useMemo, useState } from "react";
import { FolderGit2, MessageSquare, Plus, Settings2, Terminal } from "lucide-react";
import type { AgentProfile, GithubPR, GithubRepo, Player, SessionSummary } from "@/types";
import { cn } from "@/lib/utils";

export type SidebarMode = "sessions" | "code";

interface SidebarProps {
  mode: SidebarMode;
  onModeChange: (m: SidebarMode) => void;
  sessions: SessionSummary[];
  activeId: string | null;
  profiles: AgentProfile[];
  players: Player[];
  activeProfileId: string;
  repos: GithubRepo[];
  prsByRepo: Record<string, GithubPR[]>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSelectProfile: (id: string) => void;
  onOpenSettings: () => void;
  onOpenRepo: (repoId: string) => void;
  onAddRepo: (path: string) => void;
  width?: number;
}

const GROUPS: SessionSummary["group"][] = ["今天", "昨天", "更早"];

export function Sidebar({
  mode,
  onModeChange,
  sessions,
  activeId,
  profiles,
  players,
  activeProfileId,
  repos,
  prsByRepo,
  onSelect,
  onNew,
  onSelectProfile,
  onOpenSettings,
  onOpenRepo,
  onAddRepo,
  width = 260,
}: SidebarProps) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({ group: g, items: sessions.filter((s) => s.group === g) })).filter(
        (x) => x.items.length > 0,
      ),
    [sessions],
  );

  const submit = () => {
    const v = path.trim();
    if (!v) return;
    onAddRepo(v);
    setPath("");
    setAdding(false);
  };

  return (
    <aside style={{ width }} className="sc-pane flex h-full shrink-0 flex-col overflow-hidden">
      {/* 一级导航：会话 / 代码（底框 + 磨砂滑块横移） */}
      <div className="px-2.5 pt-3 pb-2.5">
        <div
          className="sc-switch"
          role="group"
          aria-label="一级导航"
          style={
            {
              "--switch-index": mode === "sessions" ? 0 : 1,
              "--switch-count": 2,
            } as React.CSSProperties
          }
        >
          <span className="sc-switch__thumb" aria-hidden="true" />
          {(
            [
              ["sessions", "会话", MessageSquare],
              ["code", "代码", FolderGit2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              aria-pressed={mode === id}
              onClick={() => onModeChange(id)}
              className="sc-switch__item"
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "sessions" ? (
        <>
          <div className="px-2.5 pb-2">
            <button
              onClick={onNew}
              className="sc-control flex w-full items-center gap-2 rounded-[8px] bg-surface-3/50 px-2.5 py-2 text-[12.5px] text-ink-1 transition-colors hover:bg-surface-3/85"
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
                        active
                          ? "sc-row-active"
                          : "hover:bg-surface-3/35",
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
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-ink-3">
              项目
            </div>
            {repos.map((r) => {
              const count = (prsByRepo[r.id] ?? []).length;
              return (
                <button
                  key={r.id}
                  onClick={() => onOpenRepo(r.id)}
                  title={r.path}
                  className="group mb-0.5 flex w-full flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-surface-3/35"
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: r.connected ? "var(--ok)" : "var(--i3)" }}
                    />
                    <span className="transition-colors duration-150 truncate text-[12px] text-ink-2 group-hover:text-ink-1">
                      {r.name}
                    </span>
                    {count > 0 && (
                      <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-3">
                        {count}
                      </span>
                    )}
                  </span>
                  <span className="truncate pl-3 font-mono text-[9.5px] text-ink-3">{r.slug}</span>
                </button>
              );
            })}

            {adding ? (
              <div className="mt-1 px-1">
                <input
                  autoFocus
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                    if (e.key === "Escape") setAdding(false);
                  }}
                  onBlur={() => setAdding(false)}
                  placeholder="/home/jerry/source/项目"
                  className="sc-selectable w-full rounded-[6px] bg-surface-3/45 px-2 py-1 font-mono text-[10.5px] text-ink-1 outline-none placeholder:text-ink-3"
                />
                <p className="mt-1 text-[9.5px] leading-relaxed text-ink-3">
                  回车添加；执行 gh 时后端把 cwd 切到这个目录
                </p>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="mt-1 flex w-full items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[11px] text-ink-3 transition-colors hover:bg-surface-3/35 hover:text-ink-2"
              >
                <Plus className="size-3" />
                添加项目路径
              </button>
            )}
          </div>
        </>
      )}

      <div className="border-t border-line-1/80 p-2">
        <div className="mb-1 px-1.5 text-[10px] text-ink-3">Agent</div>
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelectProfile(p.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors",
              p.id === activeProfileId ? "bg-surface-3/55" : "hover:bg-surface-3/35",
            )}
          >
            <span
              className={cn("size-1.5 shrink-0 rounded-full", p.connected ? "bg-ok-1" : "bg-ink-3")}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11.5px] text-ink-1">{p.name}</span>
              <span className="block truncate font-mono text-[9.5px] text-ink-3">{p.detail}</span>
            </span>
            {p.launch === "wsl" && <Terminal className="size-3 shrink-0 text-ink-3" />}
          </button>
        ))}
        <button
          onClick={onOpenSettings}
          className="mt-0.5 flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-[11.5px] text-ink-3 transition-colors hover:bg-surface-3/35 hover:text-ink-2"
        >
          <Settings2 className="size-3.5" />
          设置
        </button>
      </div>
    </aside>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderGit2, MessageSquare, Plus, Settings2 } from "lucide-react";
import type { AgentProfile, GithubPR, GithubRepo, Player, SessionSummary } from "@/types";
import { cn } from "@/lib/utils";
import { profileLabel } from "@/lib/format";
import { SessionMoreMenu } from "./SessionMcpMenu";
import { StatusDot } from "./ui/Badge";

export type SidebarMode = "sessions" | "code";

interface SidebarProps {
  mode: SidebarMode;
  onModeChange: (m: SidebarMode) => void;
  sessions: SessionSummary[];
  activeId: string | null;
  profiles: AgentProfile[];
  players: Player[];
  repos: GithubRepo[];
  prsByRepo: Record<string, GithubPR[]>;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 指定连接新建（下拉里选 agent 时用） */
  onNewWithProfile: (profileId: string) => void;
  onOpenSettings: () => void;
  /** 删除会话（App 负责确认与落库；这里只发起） */
  onDeleteSession: (s: SessionSummary) => void;
  /** 这一轮还在跑的会话：不允许删（还没有 session/cancel，删了会留下没人看的 agent） */
  isSessionBusy?: (id: string) => boolean;
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
  repos,
  prsByRepo,
  onSelect,
  onNew,
  onNewWithProfile,
  onOpenSettings,
  onDeleteSession,
  isSessionBusy,
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
            <NewSessionButton profiles={profiles} onNew={onNew} onNewWithProfile={onNewWithProfile} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {grouped.map(({ group, items }) => (
              <div key={group} className="mb-0.5">
                <div className="px-2 pt-2 pb-1 text-micro font-medium tracking-wide text-ink-3">
                  {group}
                </div>
                {items.map((s) => {
                  const active = s.id === activeId;
                  // 老会话可能没有 profileId；查不到配置时直接不渲染，避免「未知」噪音
                  const profile = s.profileId
                    ? profiles.find((p) => p.id === s.profileId)
                    : undefined;
                  const busy = isSessionBusy?.(s.id) ?? false;
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        "group relative mb-0.5 rounded-mark transition-colors",
                        active ? "sc-row-active" : "hover:bg-surface-3",
                      )}
                    >
                      <button
                        onClick={() => onSelect(s.id)}
                        className="flex w-full flex-col gap-0.5 rounded-mark px-2.5 py-2 pr-7 text-left"
                      >
                      <span
                        className={cn(
                          "truncate text-small",
                          active ? "text-ink-1" : "text-ink-2 group-hover:text-ink-1",
                        )}
                      >
                        {s.title}
                      </span>
                      <span className="flex min-w-0 items-center gap-1">
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
                        <span className="min-w-0 truncate font-mono text-micro text-ink-3">
                          {s.cwd}
                        </span>
                        {profile && (
                          <span
                            title={`归属：${profileLabel(profile)}`}
                            className={cn(
                              // 这里只说「这个会话属于谁」，不做连接状态着色 ——
                              // 状态属于当前那个会话，在标题栏里显示，列在这里会变成一堆绿灰点。
                              "ml-auto max-w-18 shrink-0 truncate rounded-mark bg-surface-3/35 px-1 py-px font-mono text-micro text-ink-3 transition-colors group-hover:bg-surface-3/55",
                            )}
                          >
                            {profileLabel(profile)}
                          </span>
                        )}
                      </span>
                      </button>
                      {/* hover 才出现：删除是低频破坏性操作，不该一直挂在那儿等误点 */}
                      <div className="absolute right-1 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <SessionMoreMenu
                          busy={busy}
                          onDelete={() => onDeleteSession(s)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="px-2 pt-1 pb-1 text-micro font-medium tracking-wide text-ink-3">
              项目
            </div>
            {repos.length === 0 && (
              <p className="px-2.5 py-1.5 text-micro leading-relaxed text-ink-3">
                还没有项目。把本地仓库路径粘到下面添加，之后 PR 与分支都会挂在这里。
              </p>
            )}
            {repos.map((r) => {
              const count = (prsByRepo[r.id] ?? []).length;
              return (
                <button
                  key={r.id}
                  onClick={() => onOpenRepo(r.id)}
                  title={r.path}
                  className="group mb-0.5 flex w-full flex-col gap-0.5 rounded-mark px-2.5 py-2 text-left transition-colors hover:bg-surface-3"
                >
                  <span className="flex items-center gap-1.5">
                    <StatusDot status={r.connected ? "connected" : "untested"} />
                    <span className="transition-colors duration-150 truncate text-small text-ink-2 group-hover:text-ink-1">
                      {r.name}
                    </span>
                    {count > 0 && (
                      <span className="ml-auto shrink-0 font-mono text-micro text-ink-3">
                        {count}
                      </span>
                    )}
                  </span>
                  <span className="truncate pl-3 font-mono text-micro text-ink-3">{r.slug}</span>
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
                  className="sc-selectable w-full rounded-mark bg-surface-3/45 px-2 py-1 font-mono text-caption text-ink-1 placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                />
                <p className="mt-1 text-micro text-ink-3">
                  回车添加；执行 gh 时后端把 cwd 切到这个目录
                </p>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="mt-1 flex w-full items-center gap-1.5 rounded-mark px-2.5 py-1.5 text-caption text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
              >
                <Plus className="size-3" />
                添加项目路径
              </button>
            )}
          </div>
        </>
      )}

      <div className="border-t border-line-1/80 p-2">
        <button
          onClick={onOpenSettings}
          className="mt-0.5 flex w-full items-center gap-2 rounded-mark px-2 py-1.5 text-ui-tight text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
        >
          <Settings2 className="size-3.5" />
          设置
        </button>
      </div>
    </aside>
  );
}

/**
 * 「新建会话」的拆分控件：主按钮沿用最近用的连接（零步骤），只配了多个连接时
 * 才亮出右侧下拉让用户指定。
 *
 * 为什么不做成「新建后去标题栏改归属」：那是把一件事拆成不连贯的两步，而且改的时候
 * 会话已经存在，用户容易先发了一句话才发现归属不对。
 */
function NewSessionButton({
  profiles,
  onNew,
  onNewWithProfile,
}: {
  profiles: AgentProfile[];
  onNew: () => void;
  onNewWithProfile: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const multi = profiles.length > 1;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="sc-control flex w-full items-center rounded-control bg-surface-3/50 transition-colors hover:bg-surface-3/85">
        <button
          onClick={onNew}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-small text-ink-1"
        >
          <Plus className="size-3.5 shrink-0 text-ink-2" />
          新建会话
          {!multi && (
            <kbd className="ml-auto rounded-mark border border-line-1/70 px-1.5 py-0.5 font-mono text-micro text-ink-3">
              Ctrl N
            </kbd>
          )}
        </button>
        {multi && (
          <button
            aria-label="选择 agent 新建会话"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mr-1 grid size-6 shrink-0 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/70 hover:text-ink-1"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>

      {open && multi && (
        <div className="sc-glass absolute top-full right-0 left-0 sc-z-popover mt-1.5 rounded-card p-1">
          <div className="px-2 py-1.5 text-micro text-ink-3">
            选一个 agent 新建；打开后会按它自动连接
          </div>
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onNewWithProfile(p.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-mark px-2 py-1.5 text-left transition-colors hover:bg-surface-3"
            >
              <span className="min-w-0 flex-1 truncate text-ui-tight text-ink-1">
                {profileLabel(p)}
              </span>
              <span className="shrink-0 font-mono text-micro text-ink-3">{p.launch}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

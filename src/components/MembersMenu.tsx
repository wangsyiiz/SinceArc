import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Plus, UserMinus, Users } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  agentUsersList,
  asCmdError,
  sessionMemberAdd,
  sessionMemberRemove,
  type AgentUser,
} from "@/lib/ipc";
import { profileLabel } from "@/lib/format";
import type { AgentProfile } from "@/types";
import { Tooltip } from "./ui/Tooltip";

/**
 * 群成员入口：把 Agent User 拉进当前会话（docs/group-chat.md §1）。
 *
 * 「创建了成员」和「这个成员在群里」是两件事：
 * - Agent User 是全局实体（设置 → 成员里建）；
 * - `@` 只在**本群成员**里找。所以没有这个入口，用户建了成员也 @ 不到。
 *
 * 每次打开都重新拉一次全局列表：设置页刚建的成员要能立刻出现在这里。
 */
export function MembersMenu({
  sessionId,
  members,
  profiles,
  onChanged,
}: {
  sessionId: string;
  /** 当前群已有成员 */
  members: AgentUser[];
  profiles: AgentProfile[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * 弹层用 fixed：左栏只有 44px 宽、父容器还带 overflow —— absolute 会被裁掉一半。
   * 位置按**面板实测高度**算，并把面板垂直居中在按钮上：
   * 之前拿固定 320px 估，估错了就变成面板往上飘、看着和按钮没关系（所有者实测反馈）。
   * 量出来之前先 hidden，避免先闪一下再跳。
   */
  const [pos, setPos] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const b = btnRef.current?.getBoundingClientRect();
    const p = panelRef.current?.getBoundingClientRect();
    if (!b || !p) return;
    const gap = 8;
    const left = Math.min(b.right + gap, window.innerWidth - p.width - 8);
    const centered = b.top + b.height / 2 - p.height / 2;
    const top = Math.max(8, Math.min(centered, window.innerHeight - p.height - 8));
    setPos({ left, top });
    // users.length：成员列表是异步来的，面板高度会变，加载完得重算一次
  }, [open, users.length]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    agentUsersList()
      .then(setUsers)
      .catch((e) => setError(asCmdError(e).msg));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const isMember = (id: string) => members.some((m) => m.id === id);

  const toggle = async (u: AgentUser) => {
    setBusy(u.id);
    setError(null);
    try {
      if (isMember(u.id)) await sessionMemberRemove(sessionId, u.id);
      else await sessionMemberAdd(sessionId, u.id);
      onChanged();
    } catch (e) {
      const err = asCmdError(e);
      setError(`${err.code} ${err.msg}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <Tooltip label={t("members.trigger")}>
        <button
          ref={btnRef}
          type="button"
          aria-label={t("members.trigger")}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "grid size-7 place-items-center rounded-full border border-dashed border-line-1/70 text-ink-3 transition-colors",
            "hover:border-line-1 hover:text-ink-1",
            open && "border-solid text-ink-1",
          )}
        >
          <Plus size={13} />
        </button>
      </Tooltip>

      {open && (
        <div
          ref={panelRef}
          className="sc-glass fixed sc-z-popover w-64 rounded-control p-2"
          style={{ ...(pos ?? { left: 0, top: 0 }), visibility: pos ? "visible" : "hidden" }}
        >
          <div className="flex items-center gap-1.5 px-1 pb-1.5">
            <Users size={12} className="text-ink-3" />
            <span className="text-caption text-ink-1">{t("members.title")}</span>
            <span className="ml-auto font-mono text-micro text-ink-3">
              {t("members.count", { count: members.length })}
            </span>
          </div>

          <p className="px-1 pb-1.5 text-micro text-ink-3">
            <Trans
              i18nKey="members.description"
              components={{ at: <span className="font-mono" /> }}
            />
          </p>

          {users.length === 0 && !error && (
            <p className="px-1 py-1 text-micro text-ink-3">
              {t("members.empty")}
            </p>
          )}

          <div className="max-h-64 overflow-y-auto">
            {users.map((u) => {
              const joined = isMember(u.id);
              const p = profiles.find((x) => x.id === u.profileId);
              return (
                <div
                  key={u.id}
                  className={cn(
                    "flex w-full items-center rounded-mark transition-colors hover:bg-surface-3/45",
                    busy === u.id && "opacity-60",
                  )}
                >
                  <button
                    type="button"
                    disabled={busy === u.id}
                    onClick={() => toggle(u)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: u.color }} />
                    <span className="shrink-0 text-caption text-ink-1">{u.name}</span>
                    <span className="shrink-0 font-mono text-micro text-ink-3">@{u.handle}</span>
                    <span className="min-w-0 flex-1 truncate text-micro text-ink-3">
                      {p ? profileLabel(p) : t("settings.connection.missing")}
                    </span>
                    {joined ? (
                      <UserMinus size={11} className="shrink-0 text-ink-3" />
                    ) : (
                      <Plus size={11} className="shrink-0 text-accent-1" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {error && (
            <p className="mt-1 break-all rounded-mark bg-danger-1/10 px-1.5 py-1 font-mono text-micro text-danger-1">
              {error}
            </p>
          )}
        </div>
      )}

    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Check, Plus, UserMinus, Users } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  /** 弹层用 fixed：左栏只有 44px 宽，父容器还带 overflow —— absolute 会被裁掉一半 */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // 面板高约 320px：底部放不下就往上收，别让它掉出视口
      const top = Math.max(8, Math.min(r.top, window.innerHeight - 336));
      setPos({ left: r.right + 8, top });
    }
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
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="群成员：拉人进这个会话"
        className={cn(
          "grid size-7 place-items-center rounded-full border border-dashed border-line-1/70 text-ink-3 transition-colors",
          "hover:border-line-1 hover:text-ink-1",
          open && "border-solid text-ink-1",
        )}
      >
        <Plus size={13} />
      </button>

      {open && (
        <div
          className="sc-glass fixed z-50 w-64 rounded-[8px] border border-line-1/60 p-2"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
        >
          <div className="flex items-center gap-1.5 px-1 pb-1.5">
            <Users size={12} className="text-ink-3" />
            <span className="text-[10.5px] text-ink-1">群成员</span>
            <span className="ml-auto font-mono text-[9.5px] text-ink-3">
              {members.length} 人
            </span>
          </div>

          <p className="px-1 pb-1.5 text-[9px] leading-relaxed text-ink-3">
            只有这里的成员能被 <span className="font-mono">@</span> 到。成员在「设置 → 成员」里创建，
            那些是全局玩家；这里决定谁在这个群里。
          </p>

          {users.length === 0 && !error && (
            <p className="px-1 py-1 text-[9.5px] leading-relaxed text-ink-3">
              还没有创建过成员 —— 先去「设置 → 成员」建一个，再回来拉进群。
            </p>
          )}

          <div className="max-h-64 overflow-y-auto">
            {users.map((u) => {
              const joined = isMember(u.id);
              const p = profiles.find((x) => x.id === u.profileId);
              return (
                <button
                  key={u.id}
                  type="button"
                  disabled={busy === u.id}
                  onClick={() => toggle(u)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-surface-3/45",
                    busy === u.id && "opacity-60",
                  )}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: u.color }} />
                  <span className="shrink-0 text-[10.5px] text-ink-1">{u.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-ink-3">@{u.handle}</span>
                  <span className="min-w-0 flex-1 truncate text-[9px] text-ink-3">
                    {p ? profileLabel(p) : "连接已不在"}
                  </span>
                  {joined ? (
                    <UserMinus size={11} className="shrink-0 text-ink-3" />
                  ) : (
                    <Plus size={11} className="shrink-0 text-accent-1" />
                  )}
                </button>
              );
            })}
          </div>

          {members.length > 0 && (
            <p className="mt-1 flex items-center gap-1 border-t border-line-1/40 px-1 pt-1 text-[9px] text-ink-3">
              <Check size={10} /> 点一下即加入 / 移出，立即生效
            </p>
          )}

          {error && (
            <p className="mt-1 break-all rounded-[4px] bg-danger-1/[0.09] px-1.5 py-1 font-mono text-[9px] leading-relaxed text-danger-1">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

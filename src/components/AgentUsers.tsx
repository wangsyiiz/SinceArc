import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Trash2, X } from "lucide-react";
import type { AgentProfile } from "@/types";
import { cn } from "@/lib/utils";
import {
  agentUserDelete,
  agentUserSave,
  agentUsersList,
  agentUserTest,
  sessionNew,
  asCmdError,
  type AgentUser,
} from "@/lib/ipc";
import { profileLabel } from "@/lib/format";

/**
 * Agent Users：群里能 @ 到的「玩家」（docs/group-chat.md §2）。
 *
 * 三件事必须做对，否则存下去就是死条目：
 * 1. 保存前**必须真跑 session/load** 测试通过；
 * 2. 改了任何一个字段 → 退回「未测试」；
 * 3. 没通过时保存禁用，并且**说清为什么**，不是灰着不解释。
 */

const COLORS = ["#8ab4f8", "#f2b8b5", "#a8d8a8", "#ffd580", "#c9a8f2", "#8fd8d2"];

type TestState =
  | { state: "untested" }
  | { state: "testing" }
  | { state: "ok"; detail: string }
  | { state: "fail"; detail: string };

interface Draft {
  id?: string;
  name: string;
  handle: string;
  color: string;
  profileId: string;
  acpSessionId: string;
  cwd: string;
}

const emptyDraft = (profiles: AgentProfile[]): Draft => ({
  name: "",
  handle: "",
  color: COLORS[0],
  profileId: profiles[0]?.id ?? "",
  acpSessionId: "",
  cwd: "",
});

export function AgentUsers({
  profiles,
  onChanged,
  ensureConnected,
}: {
  profiles: AgentProfile[];
  /** 成员变化后让外面知道（群成员列表要跟着刷新） */
  onChanged?: () => void;
  /** 「新建会话」要先确保这条连接是连着的（session/new 要求进程在线） */
  ensureConnected: (p: AgentProfile) => Promise<void>;
}) {
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [test, setTest] = useState<TestState>({ state: "untested" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 两种入口（docs/group-chat.md §2）：
   * - new：在 agent 侧真建一个新会话（session/new 成功即视为测试通过 —— 刚建成必然可用）
   * - existing：手动填一个已存在的 sessionId，必须 session/load 验过才算数
   */
  const [mode, setMode] = useState<"new" | "existing">("new");

  const reload = async () => {
    try {
      setUsers(await agentUsersList());
    } catch (e) {
      setError(asCmdError(e).msg);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const profile = profiles.find((p) => p.id === draft?.profileId);

  /** 任何字段变动都退回未测试 —— 否则会出现「用 A 的 id 测通了、改成 B 还显示通过」 */
  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setTest({ state: "untested" });
    setError(null);
  };

  /**
   * 「测试」按模式走两条路，但用户只需要点这一个按钮（所有者定的交互）：
   * - 新建会话：测试本身就包含建会话（ensure connect → session/new → 填 id），
   *   不再让用户先点一次「新建」再点一次「测试」。副作用是**真的会在 agent 上建一个会话**，
   *   所以表单里必须提前说明。
   * - 已有会话：真跑 session/load 验这个 id 能不能恢复。
   */
  const runTest = async () => {
    if (!draft || !profile) return;
    setTest({ state: "testing" });
    setError(null);
    try {
      if (mode === "new") {
        // 已经连着就别再连一次：重复 agent_connect 会报「已连接」，用户会以为建会话失败
        if (!profile.connected) await ensureConnected(profile);
        const info = await sessionNew(profile.id, draft.cwd.trim() || profile.cwd || "");
        const sid = info.sessionId;
        setDraft((d) => (d ? { ...d, acpSessionId: sid } : d));
        setTest({
          state: "ok",
          detail: `已在 ${profileLabel(profile)} 上新建会话 ${sid.length > 16 ? `${sid.slice(0, 16)}…` : sid}`,
        });
        return;
      }
      const r = await agentUserTest(profile, draft.acpSessionId.trim(), draft.cwd.trim() || undefined);
      setTest(r.ok ? { state: "ok", detail: r.detail } : { state: "fail", detail: r.detail });
    } catch (e) {
      const err = asCmdError(e);
      setTest({ state: "fail", detail: `${err.code} ${err.msg}` });
    }
  };

  const save = async () => {
    if (!draft || test.state !== "ok") return;
    setBusy(true);
    setError(null);
    try {
      await agentUserSave({
        id: draft.id ?? `u-${Date.now().toString(36)}`,
        profileId: draft.profileId,
        acpSessionId: draft.acpSessionId.trim(),
        name: draft.name.trim(),
        handle: draft.handle.trim().replace(/^@/, ""),
        color: draft.color,
        createdAt: draft.id ? (users.find((u) => u.id === draft.id)?.createdAt ?? Date.now()) : Date.now(),
      });
      setDraft(null);
      setTest({ state: "untested" });
      await reload();
      onChanged?.();
    } catch (e) {
      const err = asCmdError(e);
      setError(`${err.code} ${err.msg}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: AgentUser) => {
    try {
      await agentUserDelete(u.id);
      await reload();
      onChanged?.();
    } catch (e) {
      setError(asCmdError(e).msg);
    }
  };

  // 新建模式下有连接就能测（id 是测试时建出来的）；已有会话模式必须先填 id
  const canTest =
    !!draft && !!profile && (mode === "new" || draft.acpSessionId.trim().length > 0);
  const canSave = !!draft && test.state === "ok" && draft.name.trim().length > 0 && draft.handle.trim().length > 0;

  const saveBlocker = (() => {
    if (!draft) return null;
    if (test.state === "untested") return "先测试通过才能保存";
    if (test.state === "testing") return "正在测试…";
    if (test.state === "fail") return "测试没通过，先解决上面的问题";
    if (!draft.name.trim()) return "填个名字";
    if (!draft.handle.trim()) return "填个 @ 短名";
    return null;
  })();

  return (
    <div className="mt-2 rounded-[8px] border border-line-1/60 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-ink-1">Agent Users</span>
        <button
          type="button"
          onClick={() => {
            setDraft(emptyDraft(profiles));
            setMode("new");
            setTest({ state: "untested" });
            setError(null);
          }}
          className="flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-[10.5px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
        >
          <Plus size={12} /> 新建成员
        </button>
      </div>
      <p className="mt-1 text-[9.5px] leading-relaxed text-ink-3">
        成员 = 某条连接上的某个 ACP 会话。要能 @ 到它，这个会话必须能被 <code className="font-mono">session/load</code> 恢复 ——
        所以保存前一定会真跑一次恢复。
      </p>

      {users.length > 0 && (
        <div className="mt-2 divide-y divide-line-1/40">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2 py-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: u.color }}
                aria-hidden
              />
              <span className="shrink-0 text-[11.5px] text-ink-1">{u.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-3">@{u.handle}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-ink-3" title={u.acpSessionId}>
                {/* 连接被删时 agent_users 会级联删掉，但渲染期间轮询到中间态也不该炸 */}
                {(() => {
                  const p = profiles.find((x) => x.id === u.profileId);
                  return p ? `${profileLabel(p)} · ` : "连接已不在 · ";
                })()}
                {u.acpSessionId}
              </span>
              <button
                type="button"
                onClick={() => {
                  setDraft({
                    id: u.id,
                    name: u.name,
                    handle: u.handle,
                    color: u.color,
                    profileId: u.profileId,
                    acpSessionId: u.acpSessionId,
                    cwd: "",
                  });
                  // 编辑已有成员也从「已有会话」进：它的 id 是既有的，不该让人以为要重建
                  setMode("existing");
                  // 改没改是用户的事，能不能用是事实 —— 进来一律重新测
                  setTest({ state: "untested" });
                }}
                className="shrink-0 rounded-[6px] px-2 py-0.5 text-[10px] text-ink-2 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => remove(u)}
                className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-danger-1/10 hover:text-danger-1"
                title={`删除 ${u.name}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mt-2.5 rounded-[6px] border border-line-1/50 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-ink-2">{draft.id ? "编辑成员" : "新成员"}</span>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-[6px] p-0.5 text-ink-3 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
              title="取消"
            >
              <X size={12} />
            </button>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[9.5px] text-ink-3">名字</span>
              <input
                value={draft.name}
                onChange={(e) => edit({ name: e.target.value })}
                placeholder="后端-2"
                className="mt-0.5 h-7 w-full rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 text-[11px] text-ink-1 placeholder:text-ink-3 focus:border-accent-1/50 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[9.5px] text-ink-3">@ 短名</span>
              <input
                value={draft.handle}
                onChange={(e) => edit({ handle: e.target.value })}
                placeholder="backend"
                spellCheck={false}
                className="mt-0.5 h-7 w-full rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 font-mono text-[11px] text-ink-1 placeholder:text-ink-3 focus:border-accent-1/50 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-2">
            <span className="text-[9.5px] text-ink-3">连接</span>
            <ProfilePick
              profiles={profiles}
              value={draft.profileId}
              onChange={(id) => edit({ profileId: id })}
            />
          </div>

          {profiles.length === 0 && (
            <p className="mt-2 rounded-[4px] bg-warn-1/[0.08] px-2 py-1 text-[9.5px] leading-relaxed text-warn-1">
              还没有连接配置 —— 先去「连接」加一条，成员必须挂在某条连接上。
            </p>
          )}

          <div className="mt-2 flex gap-1 rounded-[6px] border border-line-1/60 p-0.5">
            {([
              { id: "new" as const, label: "新建会话" },
              { id: "existing" as const, label: "已有会话" },
            ]).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  if (m.id === mode) return;
                  setMode(m.id);
                  // 换了入口就把「通过」清掉：新建出来的 id 和手填的 id 不是一回事
                  setTest({ state: "untested" });
                }}
                className={cn(
                  "flex-1 rounded-[4px] px-2 py-1 text-[10.5px] transition-colors",
                  mode === m.id ? "sc-row-active text-ink-1" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === "new" && (
            <p className="mt-2 rounded-[4px] bg-warn-1/[0.08] px-2 py-1 text-[9.5px] leading-relaxed text-warn-1">
              点「测试」会<span className="text-ink-1">真的</span>在这条连接上新建一个会话
              （会占用 agent 的一个 session）。
              建完不保存就取消的话，那个会话会留在 agent 那边，客户端不会偷偷删它。
            </p>
          )}

          <label className="mt-2 block">
            <span className="text-[9.5px] text-ink-3">ACP session id</span>
            <input
              value={draft.acpSessionId}
              readOnly={mode === "new"}
              onChange={(e) => edit({ acpSessionId: e.target.value })}
              placeholder={mode === "new" ? "点上面的按钮自动生成" : "local-… 或 agent 报的 sessionId"}
              spellCheck={false}
              className="mt-0.5 h-7 w-full rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 font-mono text-[11px] text-ink-1 placeholder:text-ink-3 focus:border-accent-1/50 focus:outline-none"
            />
          </label>

          <label className="mt-2 block">
            <span className="text-[9.5px] text-ink-3">工作目录（可空，默认用连接的）</span>
            <input
              value={draft.cwd}
              onChange={(e) => edit({ cwd: e.target.value })}
              placeholder="/home/you/source"
              spellCheck={false}
              className="mt-0.5 h-7 w-full rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 font-mono text-[11px] text-ink-1 placeholder:text-ink-3 focus:border-accent-1/50 focus:outline-none"
            />
          </label>

          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[9.5px] text-ink-3">颜色</span>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setDraft({ ...draft, color: c })}
                className={cn(
                  "h-4 w-4 rounded-full border transition-colors",
                  draft.color === c ? "border-ink-1" : "border-transparent",
                )}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={!canTest || test.state === "testing"}
              className={cn(
                "rounded-[6px] px-2.5 py-1 text-[10.5px] transition-colors",
                "sc-row-active text-ink-1 hover:brightness-110",
                (!canTest || test.state === "testing") && "opacity-50",
              )}
            >
              {test.state === "testing" ? (mode === "new" ? "正在建会话…" : "测试中…") : "测试"}
            </button>
            {mode === "new" && draft.acpSessionId.trim().length > 0 && (
              <span className="text-[9.5px] text-ink-3">再点一次会再建一个会话</span>
            )}
            {mode === "existing" && !canTest && (
              // 灰着不解释是最烦人的禁用：说清要先做什么
              <span className="text-[9.5px] text-ink-3">先填一个 session id</span>
            )}
            <button
              type="button"
              onClick={save}
              disabled={!canSave || busy}
              className={cn(
                "rounded-[6px] px-2.5 py-1 text-[10.5px] transition-colors",
                canSave ? "sc-row-active text-accent-1 hover:brightness-110" : "text-ink-3",
                (!canSave || busy) && "opacity-60",
              )}
            >
              保存
            </button>
            {saveBlocker && <span className="text-[9.5px] text-ink-3">{saveBlocker}</span>}
          </div>

          {(test.state === "ok" || test.state === "fail") && (
            <p
              className={cn(
                "mt-1.5 break-all font-mono text-[9.5px] leading-relaxed",
                test.state === "ok" ? "text-ok-1" : "text-danger-1",
              )}
            >
              {test.state === "ok" ? (
                <span className="inline-flex items-center gap-1">
                  <Check size={11} /> {test.detail}
                </span>
              ) : (
                test.detail
              )}
            </p>
          )}
          {error && (
            <p className="mt-1.5 break-all rounded-[6px] bg-danger-1/[0.09] px-2 py-1 font-mono text-[9.5px] leading-relaxed text-danger-1">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 连接选择：不用原生 select（前端约束），弹层风格跟 AgentSelect 一致 */
function ProfilePick({
  profiles,
  value,
  onChange,
}: {
  profiles: AgentProfile[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = profiles.find((p) => p.id === value);
  return (
    <div ref={ref} className="relative mt-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center justify-between gap-2 rounded-[6px] border border-line-1/60 bg-surface-2/40 px-2 text-left text-[11px] text-ink-1 transition-colors hover:border-line-1"
      >
        <span className="truncate">{current ? profileLabel(current) : "选一条连接"}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div className="sc-glass absolute z-20 mt-1 w-full rounded-[6px] border border-line-1/60 p-1">
          {profiles.length === 0 && <p className="px-2 py-1 text-[10px] text-ink-3">还没有连接</p>}
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange(p.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-[4px] px-2 py-1 text-left text-[10.5px] transition-colors hover:bg-surface-3/45",
                p.id === value ? "text-ink-1" : "text-ink-2",
              )}
            >
              <span className="truncate">{profileLabel(p)}</span>
              {p.id === value && <Check size={11} className="shrink-0 text-accent-1" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

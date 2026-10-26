import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { newId } from "@/lib/ids";
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
import { PLAYER_COLORS } from "@/lib/player-colors";
import { PlayerAvatar } from "./PlayerAvatar";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import { Field, Input } from "./ui/Field";
import { useHoverCard } from "./ui/HoverCard";
import { Menu } from "./ui/Menu";
import { Segmented } from "./ui/Segmented";
import { Tooltip } from "./ui/Tooltip";

/**
 * Agent Users：群里能 @ 到的「玩家」（docs/group-chat.md §2）。
 *
 * 三件事必须做对，否则存下去就是死条目：
 * 1. 保存前**必须真跑 session/load** 测试通过；
 * 2. 改了任何一个字段 → 退回「未测试」；
 * 3. 没通过时保存禁用，并且**说清为什么**，不是灰着不解释。
 */

const COLORS = PLAYER_COLORS;

const SESSION_SOURCE_OPTIONS: { value: "new" | "existing"; label: string }[] = [
  { value: "new", label: "新建会话" },
  { value: "existing", label: "已有会话" },
];

function LongTextHover({
  text,
  disabled = false,
  className,
  children,
}: {
  text: string;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard({ disabled });
  return (
    <>
      <span ref={setEl} {...hover.triggerProps(el)} className={className}>
        {children ?? text}
      </span>
      {hover.card(<span className="break-all font-mono">{text}</span>)}
    </>
  );
}

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

/** 必填记号：颜色点一下，别让用户靠「保存按钮为什么灰着」反推哪些是必填 */
function Req() {
  return (
    <span className="ml-0.5 text-danger-1" aria-hidden>
      *
    </span>
  );
}

const emptyDraft = (profiles: AgentProfile[]): Draft => ({
  name: "",
  handle: "",
  color: COLORS[0],
  profileId: profiles[0]?.id ?? "",
  acpSessionId: "",
  cwd: "",
});

const draftOf = (user: AgentUser): Draft => ({
  id: user.id,
  name: user.name,
  handle: user.handle,
  color: user.color,
  profileId: user.profileId,
  acpSessionId: user.acpSessionId,
  cwd: "",
});

export function AgentUsersList({
  profiles,
  onChanged,
  onOpen,
  focus,
}: {
  profiles: AgentProfile[];
  onChanged?: () => void;
  onOpen: (user: AgentUser | null) => void;
  /** 从详情返回时用：优先聚焦原行，不存在则聚焦首行 */
  focus?: { id: string; tick: number } | null;
}) {
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const handledFocus = useRef<number | null>(null);

  const reload = async () => {
    try {
      setUsers(await agentUsersList());
      setError(null);
    } catch (e) {
      setError(asCmdError(e).msg);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!focus || handledFocus.current === focus.tick) return;
    const target =
      rowRefs.current[focus.id] ?? users.map((u) => rowRefs.current[u.id]).find(Boolean);
    if (!target) return;
    handledFocus.current = focus.tick;
    target.focus();
  }, [focus, users]);

  const remove = async (u: AgentUser) => {
    setBusy(u.id);
    setError(null);
    try {
      await agentUserDelete(u.id);
      await reload();
      onChanged?.();
    } catch (e) {
      setError(asCmdError(e).msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-small font-medium text-ink-2">成员</h2>
          <p className="mt-1 text-caption text-ink-3">
            成员绑定某条连接上的 ACP 会话；保存前会真跑一次恢复。
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onOpen(null)}>
          <Plus className="size-3" />
          新建成员
        </Button>
      </div>

      {error && (
        <p className="mt-3 break-all rounded-control bg-danger-1/10 px-2.5 py-2 font-mono text-caption text-danger-1">
          {error}
        </p>
      )}

      {users.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            compact
            heading="还没有成员"
            description="先在「连接」里配一条连接，再回来创建成员。"
          />
        </div>
      ) : (
        <div className="mt-4 divide-y divide-line-1/50">
          {users.map((u) => {
            const profile = profiles.find((p) => p.id === u.profileId);
            const deleteLabel = `删除 ${u.name}`;
            const deleteButton = (
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                aria-label={deleteLabel}
                disabled={busy === u.id}
                onClick={() => void remove(u)}
              >
                <Trash2 className="size-3" />
              </Button>
            );
            return (
              <div key={u.id} className="flex items-center gap-2 py-2">
                <button
                  ref={(el) => {
                    rowRefs.current[u.id] = el;
                  }}
                  type="button"
                  onClick={() => onOpen(u)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-control px-1.5 py-1.5 text-left transition-colors hover:bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                >
                  <PlayerAvatar
                    player={{
                      id: u.id,
                      name: u.name,
                      handle: u.handle,
                      color: u.color,
                      profileId: u.profileId,
                      busy: false,
                    }}
                    size={24}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-ui text-ink-1">{u.name}</span>
                      <span className="shrink-0 font-mono text-micro text-ink-3">@{u.handle}</span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-caption text-ink-3">
                      {profile ? profileLabel(profile) : "连接已不在"}
                    </span>
                  </span>
                  <Badge
                    compact
                    status={profile?.connected ? "connected" : "untested"}
                    label={profile?.connected ? "已连接" : "未连接"}
                  />
                </button>
                {busy === u.id ? (
                  deleteButton
                ) : (
                  <Tooltip label={deleteLabel}>{deleteButton}</Tooltip>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentUserDetail({
  profiles,
  user,
  ensureConnected,
  onSaved,
}: {
  profiles: AgentProfile[];
  user: AgentUser | null;
  /** 「新建会话」要先确保这条连接是连着的（session/new 要求进程在线） */
  ensureConnected: (p: AgentProfile) => Promise<void>;
  onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    user ? draftOf(user) : emptyDraft(profiles),
  );
  const [test, setTest] = useState<TestState>({ state: "untested" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 两种入口（docs/group-chat.md §2）：
   * - new：在 agent 侧真建一个新会话（session/new 成功即视为测试通过 —— 刚建成必然可用）
   * - existing：手动填一个已存在的 sessionId，必须 session/load 验过才算数
   */
  const [mode, setMode] = useState<"new" | "existing">(user ? "existing" : "new");

  const profile = profiles.find((p) => p.id === draft.profileId);

  /**
   * 改字段要不要退回「未测试」，取决于这个字段会不会让「测试结论」失效：
   *
   * - **会话字段**（连接 / session id / 工作目录）→ 必须退回。否则会出现
   *   「用 A 的 id 测通了、改成 B 还显示通过」，存下去就是死条目。
   * - **身份字段**（名字 / @ 短名 / 颜色）→ **不退回**。它们不影响那个会话能不能用，
   *   而退回会让用户「填完短名 → 又得重测 → 新建档还会再建一个会话」，纯属自找麻烦。
   */
  const edit = (patch: Partial<Draft>, opts?: { affectsSession?: boolean }) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (opts?.affectsSession) setTest({ state: "untested" });
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
    if (!profile) return;
    setTest({ state: "testing" });
    setError(null);
    try {
      if (mode === "new" && draft.acpSessionId.trim().length === 0) {
        // 已经连着就别再连一次：重复 agent_connect 会报「已连接」，用户会以为建会话失败
        if (!profile.connected) await ensureConnected(profile);
        const info = await sessionNew(profile.id, draft.cwd.trim() || profile.cwd || "");
        const sid = info.sessionId;
        setDraft((d) => ({ ...d, acpSessionId: sid }));
        setTest({
          state: "ok",
          detail: `已在 ${profileLabel(profile)} 上新建会话 ${sid.length > 16 ? `${sid.slice(0, 16)}…` : sid}`,
        });
        return;
      }
      // 无论是「已有会话」还是「新建档再点一次」，这里都是**复核**同一个 id：
      // 测试按钮因此是幂等的 —— 第二次不会再建一个会话。
      const r = await agentUserTest(
        profile,
        draft.acpSessionId.trim(),
        draft.cwd.trim() || undefined,
      );
      setTest(
        r.ok
          ? {
              state: "ok",
              detail:
                mode === "new" ? `复核通过（沿用已建的会话，不会再新建）· ${r.detail}` : r.detail,
            }
          : { state: "fail", detail: r.detail },
      );
    } catch (e) {
      const err = asCmdError(e);
      setTest({ state: "fail", detail: `${err.code} ${err.msg}` });
    }
  };

  const save = async () => {
    if (test.state !== "ok") return;
    setBusy(true);
    setError(null);
    const id = user?.id ?? newId("u");
    try {
      await agentUserSave({
        id,
        profileId: draft.profileId,
        acpSessionId: draft.acpSessionId.trim(),
        name: draft.name.trim(),
        handle: draft.handle.trim().replace(/^@/, ""),
        color: draft.color,
        createdAt: user?.createdAt ?? Date.now(),
      });
      onSaved(id);
    } catch (e) {
      const err = asCmdError(e);
      setError(`${err.code} ${err.msg}`);
    } finally {
      setBusy(false);
    }
  };

  // 新建模式下有连接就能测（id 是测试时建出来的）；已有会话模式必须先填 id
  const canTest = !!profile && (mode === "new" || draft.acpSessionId.trim().length > 0);
  const canSave =
    test.state === "ok" && draft.name.trim().length > 0 && draft.handle.trim().length > 0;

  const saveBlocker = (() => {
    if (test.state === "untested") return "先测试通过才能保存";
    if (test.state === "testing") return "正在测试…";
    if (test.state === "fail") return "测试没通过，先解决上面的问题";
    const missing = [
      !draft.name.trim() ? "名字" : null,
      !draft.handle.trim() ? "@ 短名" : null,
    ].filter(Boolean);
    if (missing.length > 0) return `还缺：${missing.join("、")}`;
    return null;
  })();

  return (
    <div className="mt-5 space-y-5">
      <p className="text-caption text-ink-3">
        成员 = 某条连接上的某个 ACP 会话。要能 @ 到它，这个会话必须能被{" "}
        <code className="font-mono">session/load</code> 恢复 —— 所以保存前一定会真跑一次恢复。
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="名字" htmlFor="member-name" required>
          <Input
            id="member-name"
            value={draft.name}
            onChange={(e) => edit({ name: e.target.value })}
            placeholder="后端-2"
          />
        </Field>
        <Field label="@ 短名" htmlFor="member-handle" required>
          <Input
            id="member-handle"
            value={draft.handle}
            onChange={(e) => edit({ handle: e.target.value })}
            placeholder="backend"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-ui font-medium text-ink-2">
          连接
          <Req />
        </span>
        <ProfilePick
          profiles={profiles}
          value={draft.profileId}
          onChange={(id) => edit({ profileId: id, acpSessionId: "" }, { affectsSession: true })}
        />
      </div>

      {profiles.length === 0 && (
        <p className="rounded-control bg-warn-1/10 px-2.5 py-2 text-caption text-warn-1">
          还没有连接配置 —— 先去「连接」加一条，成员必须挂在某条连接上。
        </p>
      )}

      <Segmented
        ariaLabel="会话来源"
        compact
        options={SESSION_SOURCE_OPTIONS}
        value={mode}
        onChange={(next) => {
          if (next === mode) return;
          setMode(next);
          // 换了入口就把「通过」清掉：新建出来的 id 和手填的 id 不是一回事
          setTest({ state: "untested" });
        }}
      />

      {mode === "new" && (
        <p className="rounded-control bg-warn-1/10 px-2.5 py-2 text-caption text-warn-1">
          点「测试」会<span className="text-ink-1">真的</span>在这条连接上新建一个会话
          （会占用 agent 的一个 session）。建完不保存就取消的话，那个会话会留在 agent
          那边，客户端不会偷偷删它。
        </p>
      )}

      {mode === "existing" ? (
        <Field label="ACP session id" htmlFor="member-session" required>
          <Input
            id="member-session"
            value={draft.acpSessionId}
            onChange={(e) =>
              edit({ acpSessionId: e.target.value }, { affectsSession: true })
            }
            placeholder="local-… 或 agent 报的 sessionId"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      ) : (
        draft.acpSessionId.trim().length > 0 && (
          <p className="text-caption text-ink-3">
            会话 id{" "}
            <LongTextHover
              text={draft.acpSessionId}
              disabled={draft.acpSessionId.length <= 28}
              className="font-mono text-ink-2"
            >
              {draft.acpSessionId.length > 28
                ? `${draft.acpSessionId.slice(0, 28)}…`
                : draft.acpSessionId}
            </LongTextHover>
          </p>
        )
      )}

      <Field label="工作目录（可空，默认用连接的）" htmlFor="member-cwd">
        <Input
          id="member-cwd"
          value={draft.cwd}
          onChange={(e) =>
            edit(
              { cwd: e.target.value },
              { affectsSession: draft.acpSessionId.trim().length === 0 },
            )
          }
          placeholder="/home/you/source"
          spellCheck={false}
          className="font-mono"
        />
      </Field>

      <div className="flex items-center gap-2">
        <span className="text-caption text-ink-3">颜色</span>
        {COLORS.map((color, index) => (
          <Tooltip key={color} label={`颜色 ${index + 1}`}>
            <button
              type="button"
              aria-label={`颜色 ${index + 1}`}
              onClick={() => setDraft({ ...draft, color })}
              className={cn(
                "size-4 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
                draft.color === color ? "border-ink-1" : "border-transparent",
              )}
              style={{ backgroundColor: color }}
            />
          </Tooltip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runTest()}
          disabled={!canTest || test.state === "testing"}
        >
          {test.state === "testing" ? (mode === "new" ? "正在建会话…" : "测试中…") : "测试"}
        </Button>
        {mode === "new" && draft.acpSessionId.trim().length > 0 && (
          <span className="text-caption text-ink-3">再点只是复核，不会新建</span>
        )}
        {mode === "existing" && !canTest && (
          <span className="text-caption text-ink-3">先填一个 session id</span>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={!canSave || busy}
        >
          保存
        </Button>
        {saveBlocker && <span className="text-caption text-ink-3">{saveBlocker}</span>}
      </div>

      {(test.state === "ok" || test.state === "fail") && (
        <p
          className={cn(
            "break-all font-mono text-caption",
            test.state === "ok" ? "text-ok-1" : "text-danger-1",
          )}
        >
          {test.state === "ok" ? (
            <span className="inline-flex items-center gap-1">
              <Check className="size-3" /> {test.detail}
            </span>
          ) : (
            test.detail
          )}
        </p>
      )}
      {error && (
        <p className="break-all rounded-control bg-danger-1/10 px-2.5 py-2 font-mono text-caption text-danger-1">
          {error}
        </p>
      )}
    </div>
  );
}

/** 连接选择：不用原生 select（前端约束），统一走菜单原语 */
function ProfilePick({
  profiles,
  value,
  onChange,
}: {
  profiles: AgentProfile[];
  value: string;
  onChange: (id: string) => void;
}) {
  const current = profiles.find((p) => p.id === value);
  return (
    <Menu
      ariaLabel="选择连接"
      compact
      align="start"
      className="w-full justify-between"
      disabled={profiles.length === 0}
      disabledReason="还没有连接"
      trigger={
        <>
          <span className="min-w-0 truncate">
            {current ? profileLabel(current) : "选一条连接"}
          </span>
          <ChevronDown className="size-3 shrink-0 text-ink-3" />
        </>
      }
      items={profiles.map((p) => ({
        id: p.id,
        label: profileLabel(p),
        checked: p.id === value,
        onSelect: () => onChange(p.id),
      }))}
    />
  );
}

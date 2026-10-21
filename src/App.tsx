import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityRail } from "@/components/ActivityRail";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { MessageItem } from "@/components/MessageItem";
import { PermissionDialog } from "@/components/PermissionDialog";
import { PrView } from "@/components/PrView";
import { RepoBrowser } from "@/components/RepoBrowser";
import { ResizeHandles } from "@/components/ResizeHandles";
import { SettingsView } from "@/components/SettingsView";
import { AgentCapabilities } from "@/components/AgentCapabilities";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MAIN_AGENT_ID } from "@/hooks/usePrompt";
import { profileLabel } from "@/lib/format";
import { findMention, mentionToken } from "@/lib/mentions";
import { pushSystemNotice } from "@/lib/notices";
import { commandLineOf, commandsFor } from "@/extensions/registry";
import { Sidebar, type SidebarMode } from "@/components/Sidebar";
import { Splitter } from "@/components/Splitter";
import { StatusBar } from "@/components/StatusBar";
import { TabStrip } from "@/components/TabStrip";
import { ThinkingRow } from "@/components/ThinkingRow";
import { TitleBar } from "@/components/TitleBar";
import { TracePanel } from "@/components/TracePanel";
import { WorkspaceEmpty } from "@/components/WorkspaceEmpty";
import { prsByRepo } from "@/mock/data";
import type {
  GithubPR,
  GithubRepo,
  PermissionRequest,
  Player,
  SessionSummary,
  Tab,
  ThreadSettings,
} from "@/types";
import {
  asCmdError,
  sessionDelete,
  sessionMembers,
  sessionUpsert,
  type AgentUser,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type ModesSnapshot,
} from "@/lib/ipc";
import { isWrite, now } from "@/lib/format";
import { clog } from "@/lib/log";
import { useAcpEvents } from "@/hooks/useAcpEvents";
import { usePaneLayout } from "@/hooks/usePaneLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { useAgentConnect } from "@/hooks/useAgentConnect";
import { useDiscovery } from "@/hooks/useDiscovery";
import { useProfileStore } from "@/hooks/useProfileStore";
import { usePrompt } from "@/hooks/usePrompt";
import { useRepos } from "@/hooks/useRepos";
import { useScrollFade } from "@/hooks/useScrollFade";
import { useSessionList } from "@/hooks/useSessionList";
import { useSessionState } from "@/hooks/useSessionState";
import { useSessionModes } from "@/hooks/useSessionModes";
import { useTabs } from "@/hooks/useTabs";
import { useTheme } from "@/hooks/useTheme";

export default function App() {
  const { theme, setTheme } = useTheme();
  useScrollFade();
  const [mode, setMode] = useState<SidebarMode>("sessions");
  const [traceOpen, setTraceOpen] = useState(false);
  const [focus, setFocus] = useState<{ id: string; tick: number } | null>(null);
  const [playerFilter, setPlayerFilter] = useState<string | null>(null);
  const [settings, setSettings] = useState<ThreadSettings>({ contextMessages: 5 });
  const [permOpen, setPermOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  /**
   * 底部浮层的实际高度。消息列表要留出这么多空间，否则最后一条会被输入框盖住 ——
   * 以前这里写死 `pb-32`（128px），输入框一高过 128px（多行输入、权限提示条、
   * 并行成本提示），最新那条回答就藏在浮层底下，看起来像「没有显示」。
   */
  const [composerH, setComposerH] = useState(128);

  const { profiles, activeProfile, addProfile, updateProfile, removeProfile } = useProfileStore();
  const discovery = useDiscovery(profiles);
  /** 当前群的成员（docs/group-chat.md §1） */
  const [members, setMembers] = useState<AgentUser[]>([]);

  /**
   * 玩家列表：群里有成员就用成员（真实的 Agent User），没有成员才退回 mock。
   * 之所以直接覆盖 `players` 这个名字：轨迹栏、@ 高亮、头像、权限弹窗全都按它取人，
   * 一处派生比到处塞 prop 更不容易漏。
   */
  const players = useMemo(
    () =>
      members.map((u) => ({
        id: u.id,
        name: u.name,
        handle: u.handle,
        color: u.color,
        profileId: u.profileId,
        busy: false,
      })),
    [members],
  );
  /**
   * 主 agent 自己的身份（只用于渲染它说过的话）。
   * 不进左栏：左栏列的是群成员，主 agent 不是成员 —— 但它的回复也该有名字，
   * 否则界面上会显示成光秃秃的「agent」。
   */
  const mainAgentPlayer = useMemo<Player>(() => {
    const prof = activeProfile;
    return {
      id: MAIN_AGENT_ID,
      name: prof ? profileLabel(prof) : "agent",
      handle: "agent",
      color: "#9aa4b2",
      profileId: prof?.id ?? "",
      busy: false,
    };
  }, [activeProfile]);

  /**
   * 渲染用的完整玩家表 = 群成员 + 主 agent。
   * 消息和思考行都必须用它：思考行的 playerId 对主 agent 是 `MAIN_AGENT_ID`，
   * 只在成员表里查会落空，之前的表现就是「发消息之后思考组件不出现」。
   */
  const renderPlayers = useMemo<Player[]>(
    () => [...players, mainAgentPlayer],
    [players, mainAgentPlayer],
  );

  const { sessions, setSessions } = useSessionList();
  const { tabs, activeTabId, setActiveTabId, activeTab, lastSessionId, setLastSessionId, openTab, closeTab, selectTab } = useTabs(sessions);
  const { state, patchSession, writeLock, initSession, sessionState } = useSessionState(lastSessionId);

  /** 重新读当前群的成员：换群、加入、移出都走它 */
  const reloadMembers = useCallback(() => {
    if (!lastSessionId) {
      setMembers([]);
      return;
    }
    sessionMembers(lastSessionId)
      .then(setMembers)
      .catch((e) => console.warn("[group] load members failed", e));
  }, [lastSessionId]);

  // 成员跟着「当前会话」走：换群就换一批人
  useEffect(() => {
    reloadMembers();
  }, [reloadMembers]);

  const { bySid: modesBySid, byProfile: modesByProfile, applyFor, choose, noteAgentSwitch } = useSessionModes();
  const onSessionBound = useCallback(
    (args: {
      profileId: string;
      acpSessionId: string;
      uiSessionId: string;
      snapshot: ModesSnapshot | null;
    }) => {
      void applyFor(args);
    },
    [applyFor],
  );
  const onAgentSwitch = useCallback(
    (uiSessionId: string, modeId: string) => noteAgentSwitch(uiSessionId, modeId),
    [noteAgentSwitch],
  );
  const onPermHead = useCallback(
    (uiSid: string, request: PermissionRequest | null) => {
      patchSession(uiSid, (s) => ({ ...s, pendingPerm: request }));
    },
    [patchSession],
  );
  const permissions = usePermissions({ onHead: onPermHead });
  const onPermission = useCallback(
    (args: { uiSid: string; profileId: string; requestId: number; params: unknown }) => {
      permissions.enqueue(args.uiSid, args.profileId, args.requestId, args.params);
    },
    [permissions.enqueue],
  );
  const { eventCount, lastEvent, eventLog, sessionsByProfile, onAgentEvent, onSession, acp } = useAcpEvents({ patchSession, setSessions, onSessionBound, onAgentSwitch, onPermission });
  const activeSession = sessions.find((s) => s.id === lastSessionId);
  // 归属跟会话走，不再跟一个全局「选中连接」走：全局选中项的唯一入口（左下角列表）
  // 已经移除，靠它就等于靠一个永远空着的值
  const sessionProfile = profiles.find((p) => p.id === activeSession?.profileId) ?? activeProfile;

  // 连接生命周期只有这一处实现：设置页手动连接、打开会话自动连接都走它
  const { connect, ensureConnected, disconnect } = useAgentConnect({
    profiles,
    sessionsByProfile,
    onUpdateProfile: updateProfile,
    onAgentEvent,
    onSession,
  });
  const profileIdOf = useCallback(
    (uiSid: string) => sessions.find((s) => s.id === uiSid)?.profileId ?? null,
    [sessions],
  );
  const { send } = usePrompt({
    lastSessionId,
    patchSession,
    activeProfile: sessionProfile,
    sessionsByProfile,
    contextMessages: settings.contextMessages,
    acp,
    profileIdOf,
    ensureConnected,
  });
  const { sidebarW, setSidebarW, traceW, setTraceW, dragging, setDragging, layoutRef, mainMin, sidebarMax, traceMax } = usePaneLayout(traceOpen);
  const { repoList, addRepo, activeRepo, activePr } = useRepos(activeTab);

  const cwd = activeSession?.cwd ?? sessionProfile?.cwd ?? "";
  const activeModeView = modesBySid[lastSessionId] ?? null;
  const activeDefaultModeLabel = sessionProfile?.defaultMode
    ? ((modesByProfile[sessionProfile.id]?.available ?? activeModeView?.available ?? []).find(
        (m) => m.id === sessionProfile.defaultMode,
      )?.name ?? sessionProfile.defaultMode)
    : null;

  /**
   * 新消息到了就滚到底。以前只设一次 `scrollTop`，字体/图片/长表格量完高度往往晚一帧，
   * 结果停在中间偏上（表现为「最后一条看不见」）。改成下一帧再补一次。
   */
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [state.msgs, activeTabId]);

  /**
   * 渲染侧对账：界面上到底拿到几条、最后一条是什么。
   * 只记条数与末尾消息的 id/角色/长度，不记正文（日志不该变成对话备份）。
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const last = state.msgs[state.msgs.length - 1];
    clog(
      "RENDER",
      `ui=${lastSessionId} n=${state.msgs.length} last=${last ? `${last.role}:${last.id.slice(0, 18)}` : "-"} len=${last?.text?.length ?? 0}`,
    );
  }, [state.msgs, lastSessionId]);

  // 队头就是当前要回答的请求：入队后自动弹出；队列清空后自动收起。
  const permHead = permissions.current(lastSessionId);
  const permQueued = permissions.count(lastSessionId);
  useEffect(() => {
    setPermOpen(permHead !== null);
  }, [permHead]);

  // 无感启动：切到某个会话标签（含从侧栏点开）就把它的 agent 拉起来。
  //
  // 尝试记录记的是「会话 + 当时的连接状态」而不是单纯的会话 id：失败之后状态不变，
  // 所以不会每次重渲染都重试（否则消息流会被同一条错误刷屏）；而断开一次状态就变了，
  // 用户再点回来就能重连 —— 断开是「现在别连」，不是「永久别连」（docs/desktop-ux.md §1.5）。
  const autoTried = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (activeTab?.kind !== "session" || !activeTab.sessionId) return;
    const sid = activeTab.sessionId;
    const pid = sessions.find((s) => s.id === sid)?.profileId ?? activeProfile?.id ?? null;
    if (!pid) return;
    const attemptKey = `${pid}:${sessionsByProfile[pid] ?? "-"}`;
    if (autoTried.current.get(sid) === attemptKey) return;
    autoTried.current.set(sid, attemptKey);
    // 带上当前会话：映射要靠它，不能靠「渲染时谁打开着」
    void ensureConnected(pid, sid).then((r) => {
      if (!r.error) return;
      patchSession(sid, (s) => ({
        ...s,
        msgs: [
          ...s.msgs,
          {
            id: `conn-err-${Date.now()}`,
            role: "system",
            text: `连接失败：${r.error!.code} ${r.error!.msg}`,
            at: now(),
          },
        ],
      }));
    });
  }, [activeTab, ensureConnected, sessions, activeProfile, sessionsByProfile, patchSession]);

  /** 把 PR 作为引用塞进会话：优先复用已打开的会话标签 */
  const quotePr = useCallback(
    (pr: GithubPR, repo: GithubRepo) => {
      const existing = tabs.find((t) => t.kind === "session");
      const sid = existing?.sessionId ?? "s-1";
      if (existing) setActiveTabId(existing.id);
      else openTab({ kind: "session", title: sessions.find((s) => s.id === sid)?.title ?? "会话", sessionId: sid });
      setLastSessionId(sid);
      patchSession(sid, (s) => ({
        ...s,
        msgs: [...s.msgs, { id: `u-${Date.now()}`, role: "user", at: now(), text: "@claude 看一下这个 PR", quoted: { kind: "pr", label: `#${pr.number} ${pr.title}`, detail: `${repo.slug} · ${pr.head} → ${pr.base} · +${pr.additions} −${pr.deletions} · ${pr.files} 文件` } }],
      }));
    },
    [openTab, patchSession, tabs],
  );

  const decide = useCallback(async (optionId: string | null) => {
    const uiSid = lastSessionId;
    try {
      // null 表示用户取消/Esc：由队列按 kind 找拒绝项，不能硬编码 optionId。
      const chosen = await permissions.decide(uiSid, optionId);
      patchSession(uiSid, (s) => ({
        ...s,
        msgs: [
          ...s.msgs,
          {
            id: `perm-${Date.now()}`,
            role: "system",
            text: `权限决定：${chosen?.label ?? "取消"}`,
            at: now(),
          },
        ],
      }));
    } catch (e) {
      const err = asCmdError(e);
      // 应答没写出去时队头仍在，界面继续显示请求，同时把原因留在消息流里。
      patchSession(uiSid, (s) => ({
        ...s,
        msgs: [
          ...s.msgs,
          {
            id: `perm-err-${Date.now()}`,
            role: "system",
            text: `权限决定失败：${err.code} ${err.msg}`,
            at: now(),
          },
        ],
      }));
    }
  }, [lastSessionId, patchSession, permissions.decide]);

  const closeSessionTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    closeTab(id);
    // 标签关掉后这条会话不会再有界面来回答权限请求，队列一并丢弃。
    if (tab?.kind === "session" && tab.sessionId) permissions.dropSession(tab.sessionId);
  }, [closeTab, permissions.dropSession, tabs]);

  const removeProfileAndPerms = useCallback((id: string) => {
    removeProfile(id);
    permissions.dropProfile(id);
  }, [permissions.dropProfile, removeProfile]);

  const newSession = useCallback((profileIdChoice?: string) => {
    const id = `s-${Date.now()}`;
    initSession(id);
    // 必须进列表：只在 tab 里存在的话，关掉标签就再也找不回来了
    // 新会话默认继承「最近用的那个连接」：没有选择步骤，也不会掉到一个空归属上；
    // 用户在侧栏拆分按钮的下拉里指定了连接时，以他选的为准
    const inheritProfile =
      (profileIdChoice ? profiles.find((p) => p.id === profileIdChoice) : undefined) ??
      profiles.find((p) => p.id === activeSession?.profileId) ??
      activeProfile;
    const summary: SessionSummary = { id, title: "新会话", cwd: inheritProfile?.cwd ?? "", updatedAt: "刚刚", updatedAtSec: Math.floor(Date.now() / 1000), group: "今天", playerIds: [], acpSessionId: null, profileId: inheritProfile?.id };
    setSessions((prev) => [summary, ...prev]);
    sessionUpsert({ id, acpSessionId: null, profileId: inheritProfile?.id ?? null, title: summary.title, cwd: summary.cwd, createdAt: summary.updatedAtSec!, updatedAt: summary.updatedAtSec! }).catch((e) => console.warn("[db] upsert session failed", e));
    openTab({ kind: "session", title: "新会话", sessionId: id });
    setLastSessionId(id);
  }, [activeProfile, activeSession, profiles, initSession, openTab, setSessions]);

  const badgeOf = useCallback((t: Tab) => {
    if (t.kind !== "session" || !t.sessionId) return null;
    const st = sessionState[t.sessionId];
    if (!st) return null;
    if (st.pendingPerm) return "var(--warn)";
    if (st.busy) return "var(--ok)";
    return null;
  }, [sessionState]);

  /** 待确认删除的会话（删除不可逆：确认框负责把后果说准） */
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  /** 删除失败时把原因留在确认框里，而不是弹一个系统 alert */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /**
   * 删除会话：**只删本软件里的**（消息、会话行、群成员关系）。
   * agent 侧那个会话原样留着 —— 用户能在别处接着用它，这一点必须在确认框里写明。
   */
  const confirmDeleteSession = async () => {
    const target = pendingDelete;
    if (!target) return;
    setDeleteError(null);
    try {
      await sessionDelete(target.id);
      setSessions((list) => list.filter((x) => x.id !== target.id));
      const tab = tabs.find((t) => t.kind === "session" && t.sessionId === target.id);
      if (tab) closeTab(tab.id);
      setPendingDelete(null);
    } catch (e) {
      const err = asCmdError(e);
      // 失败就留在框里说清楚：没删成，别让用户以为删了
      setDeleteError(`${err.code} ${err.msg}`);
    }
  };

  /**
   * 群里的发送：`@handle（docs/group-chat.md §3）`。
   *
   * - 没有 @ → 照旧投主 agent；
   * - @ 到本群成员 → 只投给那个成员（它自己的连接、它自己的 ACP 会话）；
   * - @ 了不在群里的人 → **明确失败**，不把这条消息当普通文本投给主 agent，
   *   否则用户以为成员收到了，其实是群主替他答的。
   */
  const sendInGroup = useCallback(
    async (raw: string) => {
      // 用已知短名去文本里找（短名可能含中文，字符集正则会把它截断）
      const hit = findMention(
        raw,
        members.map((u) => u.handle),
      );
      if (!hit) {
        // 敲了 @ 却一个成员都对不上：说清敲的是什么，不静默投给主 agent
        const token = mentionToken(raw);
        if (!token) return send(raw);
        pushSystemNotice(
          patchSession,
          lastSessionId,
          `@${token} 不在这个群里 —— 这条消息没有发出去（要加人请到左栏的 + 或设置 → 成员）`,
        );
        return;
      }
      // findMention 只在 members 的短名里命中，所以一定能找到人
      const who = members.find((u) => u.handle === hit.handle);
      if (!who) return;
      const prof = profiles.find((p) => p.id === who.profileId);
      return send(raw, {
        profileId: who.profileId,
        acpSessionId: who.acpSessionId,
        authorId: who.id,
        cwd: prof?.cwd ?? "",
      });
    },
    [members, profiles, send, lastSessionId, patchSession],
  );

  /**
   * 用发现到的命令直接建连接：program / args / 环境 / 工作目录都已经知道，
   * 让用户再手填一遍是白费功夫（也最容易填错）。
   */
  const useDiscovered = (c: DiscoveryCandidate, hit: DiscoveryHit) => {
    const wsl = hit.host.startsWith("wsl:");
    addProfile({
      launch: wsl ? "wsl" : "local",
      distro: wsl ? hit.host.slice("wsl:".length) : undefined,
      shell: wsl ? "zsh" : undefined,
      program: c.acpProgram,
      args: [...c.acpArgs],
      // 远端命令是 cd '<cwd>'，~ 不会被展开，所以用扫出来的绝对家目录
      cwd: hit.home ?? "",
    });
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-0 text-ink-1">
      <TitleBar profile={sessionProfile} cwd={cwd} />

      <div ref={layoutRef} className="flex min-h-0 flex-1 px-1 pb-1">
        <Sidebar
          width={sidebarW}
          mode={mode}
          onModeChange={setMode}
          sessions={sessions}
          activeId={lastSessionId}
          profiles={profiles}
          players={players}
          repos={repoList}
          prsByRepo={prsByRepo}
          onSelect={(id) => openTab({ kind: "session", sessionId: id })}
          onNew={() => newSession()}
          onNewWithProfile={(pid) => newSession(pid)}
          onOpenSettings={() => openTab({ kind: "settings", title: "设置" })}
          onDeleteSession={(x) => {
            setDeleteError(null);
            setPendingDelete(x);
          }}
          isSessionBusy={(id) => !!sessionState[id]?.busy}
          onOpenRepo={(repoId) => {
            const repo = repoList.find((r) => r.id === repoId);
            openTab({ kind: "repo", title: repo?.name ?? "项目", repoId });
          }}
          onAddRepo={addRepo}
        />

        <Splitter
          value={sidebarW}
          onChange={setSidebarW}
          onDragChange={setDragging}
          min={200}
          max={sidebarMax}
        />

        <TracePanel
          open={traceOpen}
          width={traceW}
          animate={!dragging}
          focusId={focus?.id ?? null}
          focusTick={focus?.tick ?? 0}
          turns={state.turns}
          activities={state.acts}
          players={players}
          onClose={() => {
            setTraceOpen(false);
            setFocus(null);
          }}
        />
        {traceOpen && (
          <Splitter
            value={traceW}
            onChange={setTraceW}
            onDragChange={setDragging}
            min={250}
            max={traceMax}
          />
        )}
        <main className="sc-pane flex min-h-0 flex-1 flex-col overflow-hidden" style={{ minWidth: mainMin }}>
          <TabStrip
            tabs={tabs}
            activeId={activeTabId}
            badgeOf={badgeOf}
            onSelect={selectTab}
            onClose={closeSessionTab}
          />
          {!activeTab && <WorkspaceEmpty onNewSession={newSession} />}
          {activeTab?.kind === "session" && (
            <>
              <StatusBar
                cwd={cwd}
                profile={sessionProfile}
                sessionId={sessionProfile ? sessionsByProfile[sessionProfile.id] : undefined}
                eventCount={eventCount}
                lastEvent={lastEvent}
                modes={activeModeView}
                fallbackLabel={activeDefaultModeLabel}
                onChooseMode={(modeId) => {
                  const acpSid = sessionProfile ? sessionsByProfile[sessionProfile.id] : undefined;
                  if (sessionProfile && acpSid) {
                    void choose({
                      profileId: sessionProfile.id,
                      acpSessionId: acpSid,
                      uiSessionId: lastSessionId,
                      modeId,
                    });
                  }
                }}
                traceOpen={traceOpen}
                onToggleTrace={() =>
                  setTraceOpen((v) => {
                    if (v) setFocus(null);
                    return !v;
                  })
                }
                right={
                  <AgentCapabilities
                    profile={sessionProfile}
                    commands={commandsFor(sessionProfile?.agentName, commandLineOf(sessionProfile))}
                  />
                }
              />
              <div className="flex min-h-0 flex-1">
                <ActivityRail
                  players={players}
                  activities={state.acts}
                  filter={playerFilter}
                  onFilter={setPlayerFilter}
                  group={
                    lastSessionId
                      ? {
                          sessionId: lastSessionId,
                          members,
                          profiles,
                          onChanged: reloadMembers,
                        }
                      : undefined
                  }
                />
                <div className="relative min-h-0 flex-1">
                  <div ref={scrollRef} className="h-full overflow-y-auto">
                    <div
                      className="sc-selectable mx-auto flex max-w-3xl flex-col gap-3.5 px-4 pt-4"
                      style={{ paddingBottom: composerH + 16 }}
                    >
                      {state.msgs.length === 0 ? (
                        <div className="py-12">
                          <EmptyState cwd={cwd} onPick={send} />
                        </div>
                      ) : (
                        <>
                          {state.msgs.map((m) => (
                            <MessageItem
                              key={m.id}
                              message={m}
                              players={renderPlayers}
                            />
                          ))}
                          {state.acts
                            .filter((a) => a.status === "running")
                            .map((a) => {
                              const p = renderPlayers.find((x) => x.id === a.playerId);
                              if (!p) return null;
                              const queued =
                                writeLock && writeLock.id !== a.id && isWrite(a)
                                  ? {
                                      holder:
                                        renderPlayers.find((x) => x.id === writeLock.playerId)
                                          ?.name ?? "agent",
                                    }
                                  : null;
                              return (
                                <ThinkingRow
                                  key={a.id}
                                  player={p}
                                  activity={a}
                                  queued={queued}
                                  onOpenTrace={() => {
                                    setTraceOpen(true);
                                    setFocus((f) => ({ id: a.id, tick: (f?.tick ?? 0) + 1 }));
                                  }}
                                />
                              );
                            })}
                        </>
                      )}
                    </div>
                  </div>
                  <div
                    ref={composerRef}
                    className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3"
                  >
                    <div className="mx-auto max-w-3xl">
                      {state.pendingPerm && (
                        <button
                          onClick={() => setPermOpen(true)}
                          className="sc-glass pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-[10px] border-0 shadow-none px-3 py-1.5 text-left text-[11px] text-warn-1 transition-colors hover:brightness-110"
                        >
                          <span className="shrink-0 font-medium">
                            {players.find((x) => x.id === state.pendingPerm?.playerId)?.name ??
                              "agent"}
                          </span>
                          <span className="truncate text-ink-2">
                            请求权限：{state.pendingPerm.title.replace(/？$/, "")}
                          </span>
                          <span className="ml-auto shrink-0 text-ink-3">查看</span>
                        </button>
                      )}
                      <div className="pointer-events-auto">
                        <Composer
                          busy={state.busy}
                          onSend={sendInGroup}
                          onStop={() => patchSession(lastSessionId, (s) => ({ ...s, busy: false }))}
                          placeholder="输入消息，@ 玩家提问…"
                          players={players}
                          contextMessages={settings.contextMessages}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
          {activeTab?.kind === "repo" && activeRepo && (
            <RepoBrowser
              repo={activeRepo}
              prs={prsByRepo[activeRepo.id] ?? []}
              onOpenPr={(pr) =>
                openTab({
                  kind: "pr",
                  title: `#${pr.number} ${pr.title}`,
                  subtitle: `${activeRepo.slug} · ${pr.head} → ${pr.base}`,
                  repoId: activeRepo.id,
                  prNumber: pr.number,
                })
              }
            />
          )}
          {activeTab?.kind === "settings" && (
            <SettingsView
              settings={settings}
              profiles={profiles}
              theme={theme}
              onUpdateProfile={updateProfile}
              onAddProfile={() => addProfile()}
              discovery={discovery.outcome}
              discoveryScanning={discovery.scanning}
              discoveryError={discovery.error}
              onScanDiscovery={discovery.scan}
              onUseDiscovered={useDiscovered}
              onRemoveProfile={removeProfileAndPerms}
              onConnect={connect}
              onDisconnect={disconnect}
              onDisconnected={permissions.dropProfile}
              modesFor={(pid) => modesByProfile[pid] ?? null}
              onChangeContext={(n) => setSettings((s) => ({ ...s, contextMessages: n }))}
              onCycleTheme={setTheme}
              eventLog={eventLog}
            />
          )}
          {activeTab?.kind === "pr" && activePr && activeRepo && (
            <PrView pr={activePr} repo={activeRepo} onQuote={() => quotePr(activePr, activeRepo)} />
          )}
        </main>
      </div>
      <ResizeHandles />
      {state.pendingPerm && (
        <PermissionDialog
          request={state.pendingPerm}
          player={players.find((x) => x.id === state.pendingPerm?.playerId)}
          open={permOpen}
          onDecide={(optionId) => void decide(optionId)}
          onCancel={() => void decide(null)}
          queued={permQueued}
        />
      )}

        <ConfirmDialog
          open={!!pendingDelete}
          title={`删除会话「${pendingDelete?.title ?? ""}」？`}
          body={
            <ul className="list-disc space-y-0.5 pl-4">
              <li>会删掉本软件里的这条会话记录和它的全部消息（不可恢复）。</li>
              <li>群成员关系一并消失；其他会话不受影响。</li>
              <li>
                <span className="text-ink-1">agent 那一侧的会话不会被删</span>
                ，你在别处仍然能接着用它。
              </li>
              {deleteError && (
                <li className="list-none break-all font-mono text-[10.5px] text-danger-1">
                  没删成：{deleteError}
                </li>
              )}
            </ul>
          }
          confirmLabel="删除"
          onConfirm={confirmDeleteSession}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
        />

    </div>
  );
}

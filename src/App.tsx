import { useCallback, useEffect, useRef, useState } from "react";
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
import { commandsFor } from "@/extensions/registry";
import { Sidebar, type SidebarMode } from "@/components/Sidebar";
import { Splitter } from "@/components/Splitter";
import { StatusBar } from "@/components/StatusBar";
import { TabStrip } from "@/components/TabStrip";
import { ThinkingRow } from "@/components/ThinkingRow";
import { TitleBar } from "@/components/TitleBar";
import { TracePanel } from "@/components/TracePanel";
import { WorkspaceEmpty } from "@/components/WorkspaceEmpty";
import { players, prsByRepo } from "@/mock/data";
import type { GithubPR, GithubRepo, PermissionRequest, SessionSummary, Tab, ThreadSettings } from "@/types";
import { asCmdError, sessionUpsert, type ModesSnapshot } from "@/lib/ipc";
import { isWrite, now } from "@/lib/format";
import { useAcpEvents } from "@/hooks/useAcpEvents";
import { usePaneLayout } from "@/hooks/usePaneLayout";
import { usePermissions } from "@/hooks/usePermissions";
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

  const { profiles, setProfiles, activeProfile, activeProfileId, setActiveProfileId, addProfile, removeProfile } = useProfileStore();
  const { sessions, setSessions } = useSessionList();
  const { tabs, activeTabId, setActiveTabId, activeTab, lastSessionId, setLastSessionId, openTab, closeTab, selectTab } = useTabs(sessions);
  const { state, patchSession, writeLock, initSession, sessionState } = useSessionState(lastSessionId);
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
  const { eventCount, lastEvent, eventLog, sessionsByProfile, onAgentEvent, onSession, acp } = useAcpEvents({ lastSessionId, patchSession, setSessions, onSessionBound, onAgentSwitch, onPermission });
  const { send } = usePrompt({ lastSessionId, patchSession, activeProfile, sessionsByProfile, contextMessages: settings.contextMessages, acp });
  const { sidebarW, setSidebarW, traceW, setTraceW, dragging, setDragging, layoutRef, mainMin, sidebarMax, traceMax } = usePaneLayout(traceOpen);
  const { repoList, addRepo, activeRepo, activePr } = useRepos(activeTab);

  const activeSession = sessions.find((s) => s.id === lastSessionId);
  const cwd = activeSession?.cwd ?? activeProfile?.cwd ?? "";
  const activeModeView = modesBySid[lastSessionId] ?? null;
  const activeDefaultModeLabel = activeProfile?.defaultMode
    ? ((modesByProfile[activeProfile.id]?.available ?? activeModeView?.available ?? []).find(
        (m) => m.id === activeProfile.defaultMode,
      )?.name ?? activeProfile.defaultMode)
    : null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.msgs, activeTabId]);

  // 队头就是当前要回答的请求：入队后自动弹出；队列清空后自动收起。
  const permHead = permissions.current(lastSessionId);
  const permQueued = permissions.count(lastSessionId);
  useEffect(() => {
    setPermOpen(permHead !== null);
  }, [permHead]);

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

  const newSession = useCallback(() => {
    const id = `s-${Date.now()}`;
    initSession(id);
    // 必须进列表：只在 tab 里存在的话，关掉标签就再也找不回来了
    const summary: SessionSummary = { id, title: "新会话", cwd: activeProfile?.cwd ?? "", updatedAt: "刚刚", updatedAtSec: Math.floor(Date.now() / 1000), group: "今天", playerIds: [], acpSessionId: null, profileId: activeProfile?.id };
    setSessions((prev) => [summary, ...prev]);
    sessionUpsert({ id, acpSessionId: null, profileId: activeProfile?.id ?? null, title: summary.title, cwd: summary.cwd, createdAt: summary.updatedAtSec!, updatedAt: summary.updatedAtSec! }).catch((e) => console.warn("[db] upsert session failed", e));
    openTab({ kind: "session", title: "新会话", sessionId: id });
    setLastSessionId(id);
  }, [activeProfile, initSession, openTab, setSessions]);

  const badgeOf = useCallback((t: Tab) => {
    if (t.kind !== "session" || !t.sessionId) return null;
    const st = sessionState[t.sessionId];
    if (!st) return null;
    if (st.pendingPerm) return "var(--warn)";
    if (st.busy) return "var(--ok)";
    return null;
  }, [sessionState]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-0 text-ink-1">
      <TitleBar profile={activeProfile} cwd={cwd} />

      <div ref={layoutRef} className="flex min-h-0 flex-1 px-1 pb-1">
        <Sidebar
          width={sidebarW}
          mode={mode}
          onModeChange={setMode}
          sessions={sessions}
          activeId={lastSessionId}
          profiles={profiles}
          players={players}
          activeProfileId={activeProfileId}
          repos={repoList}
          prsByRepo={prsByRepo}
          onSelect={(id) => openTab({ kind: "session", sessionId: id })}
          onNew={newSession}
          onSelectProfile={setActiveProfileId}
          onOpenSettings={() => openTab({ kind: "settings", title: "设置" })}
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
                profile={activeProfile}
                sessionId={activeProfile ? sessionsByProfile[activeProfile.id] : undefined}
                eventCount={eventCount}
                lastEvent={lastEvent}
                modes={activeModeView}
                fallbackLabel={activeDefaultModeLabel}
                onChooseMode={(modeId) => {
                  const acpSid = activeProfile ? sessionsByProfile[activeProfile.id] : undefined;
                  if (activeProfile && acpSid) {
                    void choose({
                      profileId: activeProfile.id,
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
                    profile={activeProfile}
                    commands={commandsFor(activeProfile?.agentName)}
                  />
                }
              />
              <div className="flex min-h-0 flex-1">
                <ActivityRail
                  players={players}
                  activities={state.acts}
                  filter={playerFilter}
                  onFilter={setPlayerFilter}
                />
                <div className="relative min-h-0 flex-1">
                  <div ref={scrollRef} className="h-full overflow-y-auto">
                    <div className="sc-selectable mx-auto flex max-w-3xl flex-col gap-3.5 px-4 pt-4 pb-32">
                      {state.msgs.length === 0 ? (
                        <div className="py-12">
                          <EmptyState cwd={cwd} onPick={send} />
                        </div>
                      ) : (
                        <>
                          {state.msgs.map((m) => (
                            <MessageItem key={m.id} message={m} players={players} />
                          ))}
                          {state.acts
                            .filter((a) => a.status === "running")
                            .map((a) => {
                              const p = players.find((x) => x.id === a.playerId);
                              if (!p) return null;
                              const queued =
                                writeLock && writeLock.id !== a.id && isWrite(a)
                                  ? {
                                      holder:
                                        players.find((x) => x.id === writeLock.playerId)?.name ??
                                        "agent",
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
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3">
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
                          onSend={send}
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
              onUpdateProfile={(next) =>
                setProfiles((list) => list.map((p) => (p.id === next.id ? next : p)))
              }
              onAddProfile={addProfile}
              onRemoveProfile={removeProfileAndPerms}
              onAgentEvent={onAgentEvent}
              onSession={onSession}
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
    </div>
  );
}

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
import { commandsFor } from "@/extensions/registry";
import { Sidebar, type SidebarMode } from "@/components/Sidebar";
import { Splitter } from "@/components/Splitter";
import { StatusBar } from "@/components/StatusBar";
import { TabStrip } from "@/components/TabStrip";
import { ThinkingRow } from "@/components/ThinkingRow";
import { TitleBar } from "@/components/TitleBar";
import { TracePanel } from "@/components/TracePanel";
import { WorkspaceEmpty } from "@/components/WorkspaceEmpty";
import {
  activities as seedActivities,
  messages as seedMessages,
  pendingPermission,
  players,
  prsByRepo,
  profiles as mockProfiles,
  repos as seedRepos,
  sessions,
  turns as seedTurns,
} from "@/mock/data";
import type {
  Activity,
  AgentProfile,
  GithubPR,
  GithubRepo,
  SessionState,
  Tab,
  ThemeMode,
  ThreadSettings,
} from "@/types";

const now = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const isWrite = (a: Activity) => a.kind === "edit" || a.kind === "execute";
const emptySession = (): SessionState => ({
  msgs: [],
  acts: [],
  turns: [],
  busy: false,
  pendingPerm: null,
});

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [mode, setMode] = useState<SidebarMode>("sessions");
  const [traceOpen, setTraceOpen] = useState(false);
  const [focus, setFocus] = useState<{ id: string; tick: number } | null>(null);
  const [playerFilter, setPlayerFilter] = useState<string | null>(null);
  const [settings, setSettings] = useState<ThreadSettings>({ contextMessages: 5 });
  const [activeProfileId, setActiveProfileId] = useState("p-hermes-wsl");
  const [sidebarW, setSidebarW] = useState(260);
  const [traceW, setTraceW] = useState(338);
  const [dragging, setDragging] = useState(false);
  const [repoList, setRepoList] = useState<GithubRepo[]>(seedRepos);
  const [tabs, setTabs] = useState<Tab[]>([
    { id: "tab-s-1", kind: "session", title: sessions[0].title, sessionId: "s-1" },
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>("tab-s-1");
  const [lastSessionId, setLastSessionId] = useState("s-1");
  const [permOpen, setPermOpen] = useState(false);
  const [sessionState, setSessionState] = useState<Record<string, SessionState>>({
    "s-1": {
      msgs: seedMessages,
      acts: seedActivities,
      turns: seedTurns,
      busy: false,
      pendingPerm: pendingPermission,
    },
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutW, setLayoutW] = useState(0);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const [profiles, setProfiles] = useState<AgentProfile[]>(mockProfiles);
  const addProfile = () =>
    setProfiles((list) => [
      ...list,
      {
        id: `p-new-${Date.now().toString(36)}`,
        name: "新连接",
        launch: "ssh",
        detail: "",
        connected: false,
        agentName: null,
        protocolVersion: null,
        program: "hermes",
        args: ["acp"],
        cwd: "",
        ssh: { host: "", port: 22, user: "", auth: "key" },
      },
    ]);
  const removeProfile = (id: string) => setProfiles((list) => list.filter((p) => p.id !== id));
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const activeSession = sessions.find((s) => s.id === lastSessionId);
  const cwd = activeSession?.cwd ?? "/home/jerry/source/sincearc";
  const state = sessionState[lastSessionId] ?? emptySession();

  const writeLock = state.acts.find((a) => a.status === "running" && isWrite(a)) ?? null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 滚动条透明度：伪元素不参与 transition，所以渐变靠逐帧改根节点上的 --sb-alpha
  useEffect(() => {
    const root = document.documentElement;
    let hideTimer = 0;
    let raf = 0;
    let alpha = 0.28;
    let active = false;

    const apply = (v: number) => {
      alpha = v;
      root.style.setProperty("--sb-alpha", v.toFixed(3));
    };

    const animateTo = (target: number, duration: number) => {
      cancelAnimationFrame(raf);
      const from = alpha;
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
        apply(from + (target - from) * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const onScroll = () => {
      if (!active) {
        active = true;
        animateTo(0.85, 110); // 亮起来快
      }
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        active = false;
        animateTo(0.28, 420); // 淡回去慢
      }, 600);
    };

    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.clearTimeout(hideTimer);
      cancelAnimationFrame(raf);
    };
  }, []);

  // 量三栏容器宽度：分栏上限由「主区最小宽度」反推，不是硬编码
  useEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setLayoutW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 主视图至少占一半；分栏上限由它反推
  const mainMin = Math.max(380, Math.round(layoutW / 2));
  const sidebarMax = Math.max(200, layoutW - (traceOpen ? traceW : 0) - mainMin - 12);
  const traceMax = Math.max(250, layoutW - sidebarW - mainMin - 12);

  // 窗口缩小时把超出的分栏拉回来
  useEffect(() => {
    if (!layoutW) return;
    setSidebarW((w) => Math.min(w, sidebarMax));
    setTraceW((w) => Math.min(w, traceMax));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutW, traceOpen]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.msgs, activeTabId]);

  const patchSession = useCallback((sid: string, fn: (s: SessionState) => SessionState) => {
    setSessionState((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? emptySession()) }));
  }, []);

  const openTab = useCallback((tab: Omit<Tab, "id" | "title"> & { title?: string }) => {
    const key =
      tab.kind === "session"
        ? `tab-${tab.sessionId}`
        : tab.kind === "repo"
          ? `tab-repo-${tab.repoId}`
          : tab.kind === "settings"
            ? "tab-settings"
            : `tab-pr-${tab.repoId}-${tab.prNumber}`;
    const title =
      tab.title ??
      (tab.kind === "session"
        ? (sessions.find((s) => s.id === tab.sessionId)?.title ?? "会话")
        : tab.kind === "repo"
          ? "项目"
          : tab.kind === "settings"
            ? "设置"
            : `#${tab.prNumber}`);
    setTabs((prev) => (prev.some((t) => t.id === key) ? prev : [...prev, { ...tab, id: key, title }]));
    setActiveTabId(key);
    if (tab.kind === "session" && tab.sessionId) setLastSessionId(tab.sessionId);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveTabId(fallback?.id ?? null);
      }
      return next;
    });
  }, [activeTabId]);

  const selectTab = useCallback(
    (id: string) => {
      setActiveTabId(id);
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "session" && t.sessionId) setLastSessionId(t.sessionId);
    },
    [tabs],
  );

  const send = useCallback(
    (text: string) => {
      const sid = lastSessionId;
      const at = now();
      const hits = players.filter((p) => text.includes(`@${p.handle}`));
      const targets = hits.length > 0 ? hits : [players[0]];
      const turnId = `t-${Date.now()}`;
      const actIds = targets.map((p, i) => `a-${Date.now()}-${i}-${p.id}`);

      patchSession(sid, (s) => ({
        ...s,
        busy: true,
        msgs: [...s.msgs, { id: `u-${Date.now()}`, role: "user", text, at }],
        acts: [
          ...s.acts,
          ...targets.map((p, i) => ({
            id: actIds[i],
            playerId: p.id,
            kind: "thinking" as const,
            title: "思考中",
            status: "running" as const,
            at,
          })),
        ],
        turns: [
          ...s.turns,
          {
            id: turnId,
            at,
            userText: text,
            branches: targets.map((p, i) => ({
              playerId: p.id,
              activityIds: [actIds[i]],
              status: "running" as const,
            })),
          },
        ],
      }));

      let left = targets.length;
      targets.forEach((p, i) => {
        const actId = actIds[i];
        window.setTimeout(
          () => {
            const answer = `（演示）这条本该由 ${p.name} 的 session 回答。接入后，群聊里 ${settings.contextMessages} 条上下文会作为前缀附在 prompt 里。`;
            patchSession(sid, (s) => ({
              ...s,
              acts: s.acts.map((a) =>
                a.id === actId ? { ...a, status: "ok" as const, title: "已答复" } : a,
              ),
              turns: s.turns.map((t) =>
                t.id === turnId
                  ? {
                      ...t,
                      branches: t.branches.map((b) =>
                        b.playerId === p.id
                          ? { ...b, reply: answer, status: "done" as const }
                          : b,
                      ),
                    }
                  : t,
              ),
              msgs: [
                ...s.msgs,
                {
                  id: `p-${Date.now()}-${p.id}`,
                  role: "player",
                  playerId: p.id,
                  text: answer,
                  at: now(),
                },
              ],
              busy: false,
            }));
            left -= 1;
            if (left === 0) patchSession(sid, (s) => ({ ...s, busy: false }));
          },
          900 + i * 700,
        );
      });
    },
    [lastSessionId, patchSession, settings.contextMessages],
  );

  /** 把 PR 作为引用塞进会话：优先复用已打开的会话标签 */
  const quotePr = useCallback(
    (pr: GithubPR, repo: GithubRepo) => {
      const existing = tabs.find((t) => t.kind === "session");
      const sid = existing?.sessionId ?? "s-1";
      if (existing) setActiveTabId(existing.id);
      else
        openTab({
          kind: "session",
          title: sessions.find((s) => s.id === sid)?.title ?? "会话",
          sessionId: sid,
        });
      setLastSessionId(sid);
      patchSession(sid, (s) => ({
        ...s,
        msgs: [
          ...s.msgs,
          {
            id: `u-${Date.now()}`,
            role: "user",
            at: now(),
            text: "@claude 看一下这个 PR",
            quoted: {
              kind: "pr",
              label: `#${pr.number} ${pr.title}`,
              detail: `${repo.slug} · ${pr.head} → ${pr.base} · +${pr.additions} −${pr.deletions} · ${pr.files} 文件`,
            },
          },
        ],
      }));
    },
    [openTab, patchSession, tabs],
  );

  const addRepo = useCallback((path: string) => {
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "新项目";
    setRepoList((prev) => [
      ...prev,
      { id: `r-${Date.now()}`, name, slug: `—/${name}`, path, branch: "—", connected: false },
    ]);
  }, []);

  const decide = useCallback(
    (optionId: string) => {
      setPermOpen(false);
      patchSession(lastSessionId, (s) => ({
        ...s,
        pendingPerm: null,
        msgs: [
          ...s.msgs,
          { id: `n-${Date.now()}`, role: "system", text: `权限决定：${optionId}`, at: now() },
        ],
      }));
    },
    [lastSessionId, patchSession],
  );

  const newSession = useCallback(() => {
    const id = `s-${Date.now()}`;
    setSessionState((prev) => ({ ...prev, [id]: emptySession() }));
    openTab({ kind: "session", title: "新会话", sessionId: id });
    setLastSessionId(id);
  }, [openTab]);

  const activeRepo = activeTab?.repoId
    ? repoList.find((r) => r.id === activeTab.repoId)
    : undefined;

  const activePr = useMemo(() => {
    if (activeTab?.kind !== "pr" || !activeTab.repoId) return undefined;
    return (prsByRepo[activeTab.repoId] ?? []).find((p) => p.number === activeTab.prNumber);
  }, [activeTab]);

  const badgeOf = useCallback(
    (t: Tab) => {
      if (t.kind !== "session" || !t.sessionId) return null;
      const st = sessionState[t.sessionId];
      if (!st) return null;
      if (st.pendingPerm) return "var(--warn)";
      if (st.busy) return "var(--ok)";
      return null;
    },
    [sessionState],
  );

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
            onClose={closeTab}
          />

          {!activeTab && <WorkspaceEmpty onNewSession={newSession} />}

          {activeTab?.kind === "session" && (
            <>
              <StatusBar
                cwd={cwd}
                profile={activeProfile}
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
              onRemoveProfile={removeProfile}
              onChangeContext={(n) => setSettings((s) => ({ ...s, contextMessages: n }))}
              onCycleTheme={setTheme}
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
          onDecide={decide}
        />
      )}
    </div>
  );
}

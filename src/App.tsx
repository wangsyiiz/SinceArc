import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityPanel } from "@/components/ActivityPanel";
import { ActivityRail } from "@/components/ActivityRail";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { GithubDrawer } from "@/components/GithubDrawer";
import { MessageItem } from "@/components/MessageItem";
import { PermissionDialog } from "@/components/PermissionDialog";
import { ResizeHandles } from "@/components/ResizeHandles";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { Sidebar } from "@/components/Sidebar";
import { ThinkingRow } from "@/components/ThinkingRow";
import { StatusBar } from "@/components/StatusBar";
import { TitleBar } from "@/components/TitleBar";
import { TracePanel } from "@/components/TracePanel";
import {
  activities,
  messages as seedMessages,
  pendingPermission,
  players,
  prs,
  profiles,
  sessions,
  turns,
} from "@/mock/data";
import type { GithubPR, Message, PermissionRequest, Player, ThemeMode, ThreadSettings } from "@/types";

const THEME_ORDER: ThemeMode[] = ["dark", "light", "system"];
const now = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [drawer, setDrawer] = useState<"gh" | "settings" | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(true);
  const [focus, setFocus] = useState<{ id: string; tick: number } | null>(null);
  const [playerFilter, setPlayerFilter] = useState<string | null>(null);
  const [settings, setSettings] = useState<ThreadSettings>({ contextMessages: 5 });
  const [activeSessionId, setActiveSessionId] = useState("s-1");
  const [activeProfileId, setActiveProfileId] = useState("p-hermes-wsl");
  const [msgs, setMsgs] = useState<Message[]>(seedMessages);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PermissionRequest | null>(pendingPermission);
  const [permOpen, setPermOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const cwd = activeSession?.cwd ?? "/home/jerry/source/sincearc";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const cycleTheme = useCallback(() => {
    setTheme((t) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length]);
  }, []);

  const send = useCallback((text: string) => {
    const at = now();
    setMsgs((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text, at }]);
    const hit = players.find((p) => text.includes(`@${p.handle}`));
    setBusy(true);
    window.setTimeout(() => {
      const p: Player = hit ?? players[0];
      setMsgs((prev) => [
        ...prev,
        {
          id: `p-${Date.now()}`,
          role: "player",
          playerId: p.id,
          text: `（演示）这条本该由 ${p.name} 的 session 回答。接入后，群聊里 ${settings.contextMessages} 条上下文会作为前缀附在 prompt 里。`,
          at: now(),
        },
      ]);
      setBusy(false);
    }, 900);
  }, [settings.contextMessages]);

  const quotePr = useCallback((pr: GithubPR) => {
    setMsgs((prev) => [
      ...prev,
      {
        id: `u-${Date.now()}`,
        role: "user",
        at: now(),
        text: "@claude 看一下这个 PR",
        quoted: {
          kind: "pr",
          label: `#${pr.number} ${pr.title}`,
          detail: `${pr.head} → ${pr.base} · +${pr.additions} −${pr.deletions} · ${pr.files} 文件`,
        },
      },
    ]);
    setDrawer(null);
  }, []);

  const decide = useCallback((optionId: string) => {
    setPermOpen(false);
    setPending(null);
    setMsgs((prev) => [
      ...prev,
      { id: `n-${Date.now()}`, role: "system", text: `权限决定：${optionId}`, at: now() },
    ]);
  }, []);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-0 text-ink-1">
      <TitleBar profile={activeProfile} cwd={cwd} />

      <div className="flex min-h-0 flex-1 gap-1.5 px-1 pb-1">
        <Sidebar
          sessions={sessions}
          activeId={activeSessionId}
          profiles={profiles}
          players={players}
          activeProfileId={activeProfileId}
          onSelect={setActiveSessionId}
          onNew={() => {
            setActiveSessionId("");
            setMsgs([]);
          }}
          onSelectProfile={setActiveProfileId}
          onOpenSettings={() => setDrawer(drawer === "settings" ? null : "settings")}
        />

        <TracePanel
          open={traceOpen}
          focusId={focus?.id ?? null}
          focusTick={focus?.tick ?? 0}
          turns={turns}
          activities={activities}
          players={players}
          onClose={() => setTraceOpen(false)}
        />

        <main className="sc-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <StatusBar
            cwd={cwd}
            profile={activeProfile}
            theme={theme}
            onCycleTheme={cycleTheme}
            onOpenGithub={() => setDrawer(drawer === "gh" ? null : "gh")}
            traceOpen={traceOpen}
            onToggleTrace={() => setTraceOpen((v) => !v)}
          />

          <div className="flex min-h-0 flex-1">
            <ActivityRail
              players={players}
              activities={activities}
              filter={playerFilter}
              onFilter={setPlayerFilter}
            />

            <div className="relative min-h-0 flex-1">
              <div ref={scrollRef} className="h-full overflow-y-auto">
                <div className="sc-selectable mx-auto flex max-w-3xl flex-col gap-3.5 px-4 pt-4 pb-32">
                  {msgs.length === 0 ? (
                    <div className="py-12">
                      <EmptyState cwd={cwd} onPick={send} />
                    </div>
                  ) : (
                    <>
                      {msgs.map((m) => <MessageItem key={m.id} message={m} players={players} />)}
                      {activities
                        .filter((a) => a.status === "running")
                        .map((a) => {
                          const p = players.find((x) => x.id === a.playerId);
                          if (!p) return null;
                          return (
                            <ThinkingRow
                              key={a.id}
                              player={p}
                              activity={a}
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
                  {pending && (
                    <button
                      onClick={() => setPermOpen(true)}
                      className="sc-glass pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-[10px] px-3 py-1.5 text-left text-[11px] text-warn-1 transition-colors hover:brightness-110"
                    >
                      <span className="shrink-0 font-medium">
                        {players.find((x) => x.id === pending.playerId)?.name ?? "agent"}
                      </span>
                      <span className="truncate text-ink-2">请求权限：{pending.title.replace(/？$/, "")}</span>
                      <span className="ml-auto shrink-0 text-ink-3">查看</span>
                    </button>
                  )}
                  <div className="pointer-events-auto">
                    <Composer
                      busy={busy}
                      onSend={send}
                      onStop={() => setBusy(false)}
                      placeholder="输入消息，@ 玩家提问…"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <ActivityPanel
            activities={activities}
            players={players}
            filter={playerFilter}
            open={activityOpen}
            onToggle={() => setActivityOpen((v) => !v)}
          />
        </main>
      </div>

      {drawer === "gh" && (
        <GithubDrawer
          prs={prs}
          repo="wangsyiiz/SinceArc"
          onClose={() => setDrawer(null)}
          onQuote={quotePr}
        />
      )}
      {drawer === "settings" && (
        <SettingsDrawer
          settings={settings}
          theme={theme}
          onChangeContext={(n) => setSettings((s) => ({ ...s, contextMessages: n }))}
          onCycleTheme={setTheme}
          onClose={() => setDrawer(null)}
        />
      )}

      <ResizeHandles />
      {pending && (
        <PermissionDialog
          request={pending}
          player={players.find((x) => x.id === pending.playerId)}
          open={permOpen}
          onDecide={decide}
        />
      )}
    </div>
  );
}

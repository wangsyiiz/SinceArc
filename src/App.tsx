import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { MessageItem } from "@/components/MessageItem";
import { PermissionDialog } from "@/components/PermissionDialog";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { messages as seedMessages, pendingPermission, profiles, sessions } from "@/mock/data";
import type { Message, PermissionRequest, ThemeMode } from "@/types";

const THEME_ORDER: ThemeMode[] = ["dark", "light", "system"];

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [activeSessionId, setActiveSessionId] = useState("s-1");
  const [activeProfileId, setActiveProfileId] = useState("p-hermes-wsl");
  const [msgs, setMsgs] = useState<Message[]>(seedMessages);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PermissionRequest | null>(pendingPermission);
  const [permOpen, setPermOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 演示用的滚动锚定：新消息贴着底部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const cycleTheme = useCallback(() => {
    setTheme((t) => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length]);
  }, []);

  const send = useCallback(
    (text: string) => {
      const now = new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
      setMsgs((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: "user", kind: "text", text, at: now },
      ]);
      setBusy(true);
      // 未接线：这里只是把状态走一遍，不发给任何 agent
      window.setTimeout(() => {
        setMsgs((prev) => [
          ...prev,
          {
            id: `notice-${Date.now()}`,
            role: "system",
            kind: "notice",
            text: "未接线：消息没有发往 agent",
            at: now,
          },
        ]);
        setBusy(false);
      }, 900);
    },
    [],
  );

  const decide = useCallback((optionId: string) => {
    setPermOpen(false);
    setPending(null);
    setMsgs((prev) => [
      ...prev,
      {
        id: `notice-${Date.now()}`,
        role: "system",
        kind: "notice",
        text: `权限决定：${optionId}`,
        at: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      },
    ]);
  }, []);

  return (
    <div className="grid h-full min-h-0 grid-cols-[264px_1fr] bg-surface-0 text-ink-1">
      <Sidebar
        sessions={sessions}
        activeId={activeSessionId}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelect={setActiveSessionId}
        onNew={() => {
          setActiveSessionId("");
          setMsgs([]);
        }}
        onSelectProfile={setActiveProfileId}
      />

      <main className="flex min-h-0 min-w-0 flex-col">
        <StatusBar
          cwd={activeSession?.cwd ?? "/home/jerry/source/sincearc"}
          profile={activeProfile}
          theme={theme}
          onCycleTheme={cycleTheme}
        />

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
            {msgs.length === 0 ? (
              <div className="py-10">
                <EmptyState
                  cwd={activeSession?.cwd ?? "/home/jerry/source/sincearc"}
                  onPick={send}
                />
              </div>
            ) : (
              msgs.map((m) => <MessageItem key={m.id} message={m} />)
            )}
          </div>
        </div>

        {pending && (
          <div className="mx-auto w-full max-w-3xl px-4">
            <button
              onClick={() => setPermOpen(true)}
              className="flex w-full items-center gap-2 rounded-[10px] border border-warn-1/25 bg-warn-1/[0.07] px-3 py-2 text-left text-[12px] text-warn-1 transition-colors hover:bg-warn-1/10"
            >
              <AlertCircle className="size-3.5 shrink-0" />
              <span className="truncate">
                agent 请求权限：{pending.title.replace(/？$/, "")}
              </span>
              <ChevronRight className="ml-auto size-3.5 shrink-0 opacity-70" />
            </button>
          </div>
        )}

        <Composer
          busy={busy}
          onSend={send}
          onStop={() => setBusy(false)}
          placeholder={
            activeProfile
              ? `向 ${activeProfile.name} 发送消息…`
              : "输入消息…"
          }
        />
      </main>

      {pending && (
        <PermissionDialog request={pending} open={permOpen} onDecide={decide} />
      )}
    </div>
  );
}

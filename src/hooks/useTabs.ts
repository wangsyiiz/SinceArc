import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary, Tab } from "@/types";

export function useTabs(sessions: SessionSummary[]) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [lastSessionId, setLastSessionId] = useState("");

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // openTab 原本依赖数组是 []，读的是首帧的 sessions；用 ref 存最新值，
  // 但不把 sessions 塞进依赖数组，保持原来的行为。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // 启动时列表回来了就直接打开最近一个，别让人对着一屏空白点新建
  useEffect(() => {
    if (tabs.length > 0) return;
    const first = sessions[0];
    if (!first) return;
    const tabId = `tab-${first.id}`;
    setTabs([{ id: tabId, kind: "session", title: first.title, sessionId: first.id }]);
    setActiveTabId(tabId);
    setLastSessionId(first.id);
  }, [sessions, tabs.length]);

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
        ? (sessionsRef.current.find((s) => s.id === tab.sessionId)?.title ?? "会话")
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

  return { tabs, activeTabId, setActiveTabId, activeTab, lastSessionId, setLastSessionId, openTab, closeTab, selectTab };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary, Tab } from "@/types";
import { nextActiveTabId, pruneSessionTabs } from "@/lib/tabs-prune";

export function useTabs(sessions: SessionSummary[]) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [lastSessionId, setLastSessionId] = useState("");

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // openTab 原本依赖数组是 []，读的是首帧的 sessions；用 ref 存最新值，
  // 但不把 sessions 塞进依赖数组，保持原来的行为。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /**
   * 自动打开「只做一次」。
   *
   * 以前没有这个标记，条件是 `tabs.length === 0` —— 用户把最后一个标签关掉时
   * `tabs.length` 回到 0，effect 立刻又把 `sessions[0]` 打开，于是标签永远关不完。
   * 自动行为必须一次性，不能跟着「当前是不是空」反复触发。
   */
  const autoOpenedRef = useRef(false);

  // 启动时列表回来了就直接打开最近一个，别让人对着一屏空白点新建
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (tabs.length > 0) {
      autoOpenedRef.current = true;
      return;
    }
    const first = sessions[0];
    if (!first) return;
    autoOpenedRef.current = true;
    const tabId = `tab-${first.id}`;
    setTabs([{ id: tabId, kind: "session", title: first.title, sessionId: first.id }]);
    setActiveTabId(tabId);
    setLastSessionId(first.id);
  }, [sessions, tabs.length]);

  /**
   * 列表里没了 = 会话被删了，对应标签必须跟着关。
   *
   * 删除流程自己也会关一次标签，但那是「删除按钮这条路径」的保证；这里按列表兜底，
   * 免得别的路径（列表刷新、别处删掉）留下一具空标签 —— 界面上看起来就是「删了会话，
   * 右边那个标签还在」。
   */
  const seenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const alive = new Set(sessions.map((s) => s.id));
    const seen = seenIdsRef.current;
    setTabs((prev) => {
      const kept = pruneSessionTabs(prev, alive, seen);
      if (kept === prev) return prev;
      setActiveTabId((current) => nextActiveTabId(kept, current, prev));
      return kept;
    });
    for (const id of alive) seen.add(id);
  }, [sessions]);

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

  /** 按会话 id 关标签：删除会话时用，不依赖调用方手里的 tabs 快照。 */
  const closeSessionTabs = useCallback((sessionId: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => !(t.kind === "session" && t.sessionId === sessionId));
      if (next.length === prev.length) return prev;
      setActiveTabId((current) => {
        if (current && next.some((t) => t.id === current)) return current;
        return next[0]?.id ?? null;
      });
      return next;
    });
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

  return { tabs, activeTabId, setActiveTabId, activeTab, lastSessionId, setLastSessionId, openTab, closeTab, closeSessionTabs, selectTab };
}

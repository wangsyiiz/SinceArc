import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary, Tab } from "@/types";
import {
  nextActiveTabId,
  prunePinnedSessions,
  pruneSessionTabs,
  sessionIdForActiveTab,
} from "@/lib/tabs-prune";
import { i18nText } from "@/lib/i18n-text";

const PINNED_KEY = "sincearc.tabs.pinned";

function readPinnedSessions(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function writePinnedSessions(pinned: ReadonlySet<string>) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]));
  } catch {
    // localStorage 不可用时只是不持久化，标签栏本身照常工作。
  }
}

function sessionIdOf(tab: Tab): string | null {
  return tab.kind === "session" && tab.sessionId ? tab.sessionId : null;
}

/** pinned 组在前，组内与组外都按标签的原始打开顺序稳定排列。 */
function orderTabs(tabs: Tab[], pinned: ReadonlySet<string>, baseOrder: readonly string[]): Tab[] {
  const rank = new Map(baseOrder.map((id, index) => [id, index]));
  return [...tabs].sort((a, b) => {
    const aPinned = pinned.has(sessionIdOf(a) ?? "") ? 0 : 1;
    const bPinned = pinned.has(sessionIdOf(b) ?? "") ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    return (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function useTabs(sessions: SessionSummary[]) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [lastSessionId, setLastSessionId] = useState("");
  const [pinned, setPinned] = useState<Set<string>>(readPinnedSessions);

  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const baseOrderRef = useRef<string[]>([]);

  useEffect(() => {
    writePinnedSessions(pinned);
  }, [pinned]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // 标签关闭、剪枝、切换都只保证 activeTabId 正确；这里统一把它同步成聊天区
  // 应该渲染的会话，避免关掉当前标签后聊天区还停在被关掉的会话上。
  useEffect(() => {
    const sessionId = sessionIdForActiveTab(tabs, activeTabId);
    if (sessionId === null) return;
    setLastSessionId(sessionId);
  }, [tabs, activeTabId]);

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
    setPinned((prev) => prunePinnedSessions(prev, alive, seen));
    setTabs((prev) => {
      const kept = pruneSessionTabs(prev, alive, seen);
      if (kept === prev) return prev;
      const keptIds = new Set(kept.map((tab) => tab.id));
      baseOrderRef.current = baseOrderRef.current.filter((id) => keptIds.has(id));
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
        ? (sessionsRef.current.find((s) => s.id === tab.sessionId)?.title ??
          i18nText("app.tab.session"))
        : tab.kind === "repo"
          ? i18nText("app.tab.repo")
          : tab.kind === "settings"
            ? i18nText("app.tab.settings")
            : `#${tab.prNumber}`);
    if (!baseOrderRef.current.includes(key)) baseOrderRef.current.push(key);
    setTabs((prev) => {
      if (prev.some((t) => t.id === key)) return prev;
      return orderTabs([...prev, { ...tab, id: key, title }], pinnedRef.current, baseOrderRef.current);
    });
    setActiveTabId(key);
    if (tab.kind === "session" && tab.sessionId) setLastSessionId(tab.sessionId);
  }, []);

  // 启动时列表回来了就先按持久化顺序重建 pinned，再打开最近一个。
  // 自动行为仍然只做一次；用户手动关掉最后一个标签时不会再被强行打开。
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (tabs.length > 0) {
      autoOpenedRef.current = true;
      return;
    }
    const first = sessions[0];
    if (!first) return;
    autoOpenedRef.current = true;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const id of pinnedRef.current) {
      const summary = byId.get(id);
      if (!summary) continue;
      openTab({ kind: "session", sessionId: id, title: summary.title });
    }
    openTab({ kind: "session", sessionId: first.id, title: first.title });
  }, [openTab, sessions, tabs.length]);

  /** 按会话 id 关标签：删除会话时用，不依赖调用方手里的 tabs 快照。 */
  const closeSessionTabs = useCallback((sessionId: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => !(t.kind === "session" && t.sessionId === sessionId));
      if (next.length === prev.length) return prev;
      const keptIds = new Set(next.map((tab) => tab.id));
      baseOrderRef.current = baseOrderRef.current.filter((id) => keptIds.has(id));
      setActiveTabId((current) => {
        if (current && next.some((t) => t.id === current)) return current;
        return next[0]?.id ?? null;
      });
      return next;
    });
    setPinned((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (next.length === prev.length) return prev;
      baseOrderRef.current = baseOrderRef.current.filter((tabId) => tabId !== id);
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

  const pinTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    const sessionId = tab ? sessionIdOf(tab) : null;
    if (!sessionId || pinnedRef.current.has(sessionId)) return;
    const nextPinned = new Set(pinnedRef.current);
    nextPinned.add(sessionId);
    pinnedRef.current = nextPinned;
    setPinned(nextPinned);
    setTabs((prev) => orderTabs(prev, nextPinned, baseOrderRef.current));
  }, []);

  const unpinTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    const sessionId = tab ? sessionIdOf(tab) : null;
    if (!sessionId || !pinnedRef.current.has(sessionId)) return;
    const nextPinned = new Set(pinnedRef.current);
    nextPinned.delete(sessionId);
    pinnedRef.current = nextPinned;
    setPinned(nextPinned);
    setTabs((prev) => orderTabs(prev, nextPinned, baseOrderRef.current));
  }, []);

  return {
    tabs,
    activeTabId,
    setActiveTabId,
    activeTab,
    lastSessionId,
    setLastSessionId,
    openTab,
    closeTab,
    closeSessionTabs,
    selectTab,
    pinned,
    onPin: pinTab,
    onUnpin: unpinTab,
  };
}

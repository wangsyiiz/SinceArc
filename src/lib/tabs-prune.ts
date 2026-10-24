import type { Tab } from "@/types";

/**
 * 会话被删掉后，会话列表里已经没有它了 —— 对应的标签不能继续挂着。
 *
 * 只在「列表里出现过、现在没了」时剪枝：新建会话的标签可能比列表早一步出现
 * （新会话先落到 tabs 再回流 sessions），按「不在列表里」直接剪会把新标签当场剪掉。
 */
export function pruneSessionTabs(
  tabs: Tab[],
  alive: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Tab[] {
  const kept = tabs.filter((tab) => {
    if (tab.kind !== "session" || !tab.sessionId) return true;
    if (alive.has(tab.sessionId)) return true;
    // 从没见过 = 刚打开还没回流，留着
    return !seen.has(tab.sessionId);
  });
  return kept.length === tabs.length ? tabs : kept;
}

/** 剪枝后如果当前标签没了，落到它右边那个（没有就左边那个）。 */
export function nextActiveTabId(tabs: Tab[], activeId: string | null, before: Tab[]): string | null {
  if (!activeId) return null;
  if (tabs.some((tab) => tab.id === activeId)) return activeId;
  const index = before.findIndex((tab) => tab.id === activeId);
  if (index < 0) return tabs[0]?.id ?? null;
  const aliveIds = new Set(tabs.map((tab) => tab.id));
  for (let i = index + 1; i < before.length; i += 1) {
    if (aliveIds.has(before[i].id)) return before[i].id;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (aliveIds.has(before[i].id)) return before[i].id;
  }
  return tabs[0]?.id ?? null;
}

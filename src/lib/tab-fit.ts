/**
 * 按容器可用宽度决定标签栏里放几个标签。
 *
 * `tabs` 是显示顺序（pinned 已由 useTabs 排到最左）；本函数只负责取舍，
 * 返回的两个数组都保持 `tabs` 里的原顺序。active 与 pinned 是硬约束：
 * 即使宽度连一个标签都放不下，它们也不会进入 overflow。
 */
export function fitTabs(input: {
  width: number;
  minW: number;
  gap: number;
  tabs: string[];
  pinned: string[];
  activeId: string | null;
}): { visible: string[]; overflow: string[] } {
  const { width, minW, gap, tabs, pinned, activeId } = input;
  if (tabs.length === 0) return { visible: [], overflow: [] };

  const unit = minW + gap;
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const capacity = unit > 0 ? Math.max(0, Math.floor((safeWidth + gap) / unit)) : 0;

  const present = new Set(tabs);
  const required = new Set<string>();
  if (activeId && present.has(activeId)) required.add(activeId);
  for (const id of pinned) {
    if (present.has(id)) required.add(id);
  }

  const visible = new Set(required);
  const limit = Math.max(capacity, required.size);
  for (const id of tabs) {
    if (visible.size >= limit) break;
    visible.add(id);
  }
  if (visible.size === 0) visible.add(tabs[0]);

  return {
    visible: tabs.filter((id) => visible.has(id)),
    overflow: tabs.filter((id) => !visible.has(id)),
  };
}

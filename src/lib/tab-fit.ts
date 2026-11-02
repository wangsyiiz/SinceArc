/**
 * 按容器可用宽度决定标签栏里放几个标签，以及每个标签该多宽（§39）。
 *
 * 宽度规则是三段式：
 * 1. 放得下就按**最大宽度**（`maxW`）显示，不随容器拉宽；
 * 2. 标签变多时**收窄**，一直收到**最小宽度**（`minW`）为止 —— 这一段全部可见、不出现溢出按钮；
 * 3. 收到最小宽度还放不下，才按最小宽度算容量，多出来的进右侧下拉菜单。
 *
 * 早先只有最小宽度（等于固定宽度），于是两三个标签时也顶着 120px、右侧留一大片空白；
 * 反过来如果只按「等分」算，标签少时会被拉得像横幅。所以两端都得有界。
 *
 * `tabs` 是显示顺序（pinned 已由 useTabs 排到最左）；本函数只负责取舍，
 * 返回的两个数组都保持 `tabs` 里的原顺序。active 与 pinned 是硬约束：
 * 即使宽度连一个标签都放不下，它们也不会进入 overflow。
 */
export type TabFit = {
  visible: string[];
  overflow: string[];
  /** 可见标签的渲染宽度（px）；0 表示还没量到容器宽度 */
  tabWidth: number;
};

export function fitTabs(input: {
  width: number;
  minW: number;
  gap: number;
  /** 缺省等于 minW（此时退化成「固定宽度」的老行为） */
  maxW?: number;
  tabs: string[];
  pinned: string[];
  activeId: string | null;
}): TabFit {
  const { width, minW, gap, tabs, pinned, activeId } = input;
  const maxW = Math.max(input.maxW ?? minW, minW);
  if (tabs.length === 0) return { visible: [], overflow: [], tabWidth: maxW };

  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const count = tabs.length;
  // 等分时每个标签能拿到多少（扣掉 n-1 条分隔）
  const evenly = (safeWidth - gap * (count - 1)) / count;

  if (evenly >= maxW) {
    return { visible: [...tabs], overflow: [], tabWidth: maxW };
  }
  if (evenly >= minW) {
    return { visible: [...tabs], overflow: [], tabWidth: Math.floor(evenly) };
  }

  // 收到最小宽度还放不下：按最小宽度算容量，其余进溢出
  const unit = minW + gap;
  const capacity = unit > 0 ? Math.max(0, Math.floor((safeWidth + gap) / unit)) : 0;

  const present = new Set(tabs);
  const required = new Set<string>();
  if (activeId && present.has(activeId)) required.add(activeId);
  for (const id of pinned) {
    if (present.has(id)) required.add(id);
  }

  const visibleSet = new Set(required);
  const limit = Math.max(capacity, required.size);
  for (const id of tabs) {
    if (visibleSet.size >= limit) break;
    visibleSet.add(id);
  }
  if (visibleSet.size === 0) visibleSet.add(tabs[0]);

  return {
    visible: tabs.filter((id) => visibleSet.has(id)),
    overflow: tabs.filter((id) => !visibleSet.has(id)),
    tabWidth: minW,
  };
}

/** 与「回到底部」按钮共用的贴底阈值。 */
export const AT_BOTTOM_THRESHOLD_PX = 8;

export interface BottomMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isAtBottom(
  metrics: BottomMetrics,
  threshold = AT_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function shouldFollowBottom(stickToBottom: boolean, atBottom: boolean): boolean {
  return stickToBottom && atBottom;
}

/**
 * 已知某行在变化前后的视口偏移时，算出恢复原偏移需要的 scrollTop。
 *
 * 插入/变高会让 currentOffset 变大，需要向下补同样距离；变矮反之。
 */
export function anchorTargetScrollTop(
  scrollTop: number,
  currentOffset: number,
  originalOffset: number,
): number {
  return scrollTop + currentOffset - originalOffset;
}

/**
 * 尾部是否变了 —— 只认「最后一条换了」，前插（加载更早）不算。
 * 贴底跟随只该由尾部变化触发：否则用户点「加载更早」时会被拽回底部。
 */
export function isTailChange(prevTailKey: string | null, nextTailKey: string | null): boolean {
  if (nextTailKey === null) return false;
  if (prevTailKey === null) return true;
  return prevTailKey !== nextTailKey;
}

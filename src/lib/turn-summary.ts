import type { TraceTurn } from "@/types";

/** 轮头行内短标签：「第 N 轮」。index 是 turns 数组下标。 */
export function turnLabel(index: number): string {
  return `第 ${index + 1} 轮`;
}

/**
 * 轮头完整摘要：「第 N 轮 · 时刻 · 结局」。
 *
 * 只取轮的身份、开始时刻与结局 —— 轨迹面板只讲过程，用户原文留在聊天区
 * （docs/message-model.md §11）。
 */
export function turnHeading(
  turn: Pick<TraceTurn, "at">,
  index: number,
  outcomeLabel: string,
): string {
  return [turnLabel(index), turn.at, outcomeLabel].filter((part) => part.length > 0).join(" · ");
}

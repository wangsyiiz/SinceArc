/**
 * 会话数据面的唯一解析口（docs/data-plane.md §2）。
 *
 * 界面只持有 `uiSessionId`，其余 id 由它派生。这里只做「按顺序取第一个有值的」，
 * **不做任何兜底猜测** —— 尤其不许用「连接当前会话」顶上：那是另一条会话的 agent 上下文。
 */

export function resolveAcpSessionId(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** 界面会话这一层缺 id 时，明确回答「还没有」而不是借一个。 */
export type AcpSessionSource = "record" | "event" | "none";

export function describeSource(
  record: string | null | undefined,
  event: string | null | undefined,
): AcpSessionSource {
  if (record && record.trim()) return "record";
  if (event && event.trim()) return "event";
  return "none";
}

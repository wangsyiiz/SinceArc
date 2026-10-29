/**
 * 状态栏「进行中」计数（docs/desktop-ux.md §26.2）。
 *
 * `toolCalls` 只保留每个 agent 最近一条的合并态，用来画活动行标签；
 * 这里按 `acpSessionId → toolCallId` 建表，专门回答「现在有几条在跑」。
 */
export interface InFlightTool {
  toolCallId: string;
  acpSessionId: string;
  title: string;
  /** 客户端第一次看到这条 toolCall 的时刻（毫秒） */
  startedAt: number;
}

function isTerminal(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

function isActive(status: unknown): boolean {
  return status === "pending" || status === "in_progress";
}

function tableKey(acpSessionId: string, toolCallId: string): string {
  return `${acpSessionId}\u0000${toolCallId}`;
}

/** 把一条 session/update 的 tool_call / tool_call_update 合并进表；返回新表（不改入参）。 */
export function reduceInFlight(
  table: Record<string, InFlightTool>,
  acpSessionId: string,
  update: Record<string, unknown>,
  now: number,
): Record<string, InFlightTool> {
  const toolCallId = update.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId) return table;

  const key = tableKey(acpSessionId, toolCallId);
  const existing = table[key];
  if (isTerminal(update.status)) {
    if (!existing) return table;
    const next = { ...table };
    delete next[key];
    return next;
  }
  // 增量更新可能只带 title；已有条目沿用原状态，无条目时仍按「status 缺失 = 不猜」处理。
  if (!isActive(update.status) && !(existing && update.status == null)) return table;

  const title =
    typeof update.title === "string" && update.title ? update.title : (existing?.title ?? "");
  if (existing && existing.title === title) return table;
  return {
    ...table,
    [key]: {
      toolCallId,
      acpSessionId,
      title,
      startedAt: existing?.startedAt ?? now,
    },
  };
}

/** 该 agent 的一轮结束 / 新一轮开始：清掉它名下的在途条目。 */
export function clearInFlight(
  table: Record<string, InFlightTool>,
  acpSessionId: string,
): Record<string, InFlightTool> {
  let changed = false;
  const next: Record<string, InFlightTool> = {};
  for (const [key, item] of Object.entries(table)) {
    if (item.acpSessionId === acpSessionId) {
      changed = true;
      continue;
    }
    next[key] = item;
  }
  return changed ? next : table;
}

/** 所有连接的在途条目，按 startedAt 升序（最久的最前）——UI 直接用这个顺序。 */
export function listInFlight(table: Record<string, InFlightTool>): InFlightTool[] {
  return Object.values(table).sort(
    (a, b) =>
      a.startedAt - b.startedAt ||
      a.acpSessionId.localeCompare(b.acpSessionId) ||
      a.toolCallId.localeCompare(b.toolCallId),
  );
}

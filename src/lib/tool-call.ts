/**
 * `session/update` 里的 `tool_call` / `tool_call_update` → 活动行的字段。
 *
 * 单独放在这里而不是塞进 `useAcpEvents`，是因为 `node --test` 不能加载带 `@/` 别名的
 * React hook：合并语义（`null` 不覆盖）、截断形状、终态不重置
 * 这几条只有靠用例才能盯住，错了的症状是「活动行偶尔退回思考中」。
 */
import type { Activity, ActivityKind } from "@/types";
import { rawInputLines } from "./trace-adapter.ts";

export interface ToolCallPayload {
  toolCallId?: string | null;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
}

export interface ToolCallState {
  toolCallId: string | null;
  title: string | null;
  kind: string | null;
  status: string | null;
  rawInput: unknown;
}

const EMPTY_STATE: ToolCallState = {
  toolCallId: null,
  title: null,
  kind: null,
  status: null,
  rawInput: undefined,
};

/** 只认两种 sessionUpdate；其余（thought/message/mode）不归这里。 */
export function asToolCallPayload(
  update: Record<string, unknown> | undefined,
): ToolCallPayload | null {
  const sessionUpdate = update?.sessionUpdate;
  if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") return null;
  const payload: ToolCallPayload = {};
  if (typeof update?.toolCallId === "string") payload.toolCallId = update.toolCallId;
  if (typeof update?.title === "string") payload.title = update.title;
  if (typeof update?.kind === "string") payload.kind = update.kind;
  if (typeof update?.status === "string") payload.status = update.status;
  if (update && "rawInput" in update) payload.rawInput = update.rawInput;
  return payload;
}

function startsNewCall(prev: ToolCallState | null, payload: ToolCallPayload): boolean {
  if (!prev) return true;
  if (payload.toolCallId == null || prev.toolCallId == null) return false;
  return payload.toolCallId !== prev.toolCallId;
}

/**
 * 增量合并：与后端 `merge_tool_call` 同语义 —— `null` 不覆盖已有值。
 * 换了一个 toolCallId 才从空状态起算；同 id 的重发/增量都合并，
 * 免得一条只带 title 的事件把已有 rawInput 清掉。
 */
export function mergeToolCall(
  prev: ToolCallState | null,
  payload: ToolCallPayload,
): ToolCallState {
  const base: ToolCallState = startsNewCall(prev, payload)
    ? { ...EMPTY_STATE }
    : { ...(prev as ToolCallState) };

  if (payload.toolCallId != null) base.toolCallId = payload.toolCallId;
  if (payload.title != null) base.title = payload.title;
  if (payload.kind != null) base.kind = payload.kind;
  if (payload.status != null) base.status = payload.status;
  if (payload.rawInput !== undefined && payload.rawInput !== null) base.rawInput = payload.rawInput;
  return base;
}

/** 只用于决定标签：缺失 / think → 思考中，其余 → 调用工具中。 */
export function activityKindForTool(kind: string | null | undefined): ActivityKind {
  switch (kind) {
    case undefined:
    case null:
    case "":
    case "think":
      return "thinking";
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "execute";
    default:
      // fetch / other / 未来新增的 kind：界面上都属于「调用工具中」。
      return "plan";
  }
}

function truncatedMarker(value: unknown): { bytes: number; preview: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.__truncated !== true) return null;
  return {
    bytes: typeof obj.bytes === "number" ? obj.bytes : 0,
    preview: typeof obj.preview === "string" ? obj.preview : "",
  };
}

/** `body` = `rawInputLines(rawInput).join("\n")`；截断形状只取 `preview`。 */
export function toolCallBody(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) return undefined;
  const marker = truncatedMarker(rawInput);
  if (marker) return marker.preview;
  return rawInputLines(rawInput).join("\n");
}

export function isTerminalToolStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

export interface ToolActivityFields {
  kind: ActivityKind;
  title: string;
  body: string | undefined;
}

/**
 * 终态（`completed` / `failed`）返回 `null`：活动行保持最后一次调用的样子，
 * 直到下一次 `tool_call` 覆盖或这一轮收口（§21.3）。
 */
export function toolActivityFields(state: ToolCallState): ToolActivityFields | null {
  if (isTerminalToolStatus(state.status)) return null;
  return {
    kind: activityKindForTool(state.kind),
    title: state.title ?? "",
    body: toolCallBody(state.rawInput),
  };
}

/**
 * 写回该 ACP 会话那条 running 活动行。找不到 / 已经不是 running → 返回 `null`，
 * 调用方不新建行（事件可能不属于当前界面会话，或这一轮已经收口）。
 *
 * `detail` 显式清空：工具调用不把 rawInput 再写一遍（§21.1）。
 * 增量没带 title 时保留行上已有标题，避免把主行清空。
 */
export function applyToolCallFields(
  acts: Activity[],
  actId: string,
  fields: ToolActivityFields,
): Activity[] | null {
  const index = acts.findIndex((activity) => activity.id === actId);
  if (index < 0) return null;
  const target = acts[index];
  if (target.status !== "running") return null;

  const next = [...acts];
  next[index] = {
    ...target,
    kind: fields.kind,
    title: fields.title || target.title,
    body: fields.body,
    detail: undefined,
  };
  return next;
}

export interface ToolCallReduction {
  /** 合并后的调用状态；下一次增量从这里继续。 */
  nextState: ToolCallState;
  /** 要写回行上的字段；null = 终态，这一条不改行。 */
  fields: ToolActivityFields | null;
}

/**
 * 一条 `session/update` 的完整归约；`useAcpEvents` 与用例共用这一个入口。
 * 返回 `null` = 不是工具调用事件，调用方继续走别的分支。
 */
export function reduceToolCall(
  prev: ToolCallState | null,
  update: Record<string, unknown> | undefined,
): ToolCallReduction | null {
  const parsed = asToolCallPayload(update);
  if (!parsed) return null;
  const nextState = mergeToolCall(prev, parsed);
  return { nextState, fields: toolActivityFields(nextState) };
}

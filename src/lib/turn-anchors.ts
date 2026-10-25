/**
 * 正文与轨迹互找的纯函数。
 *
 * 归属只看 `Message.turnId`（数据库 `messages.turn_id` 的投影），不按时间推断。
 * 空串/纯空格与 NULL 同义，统一走 `normaliseTurnId`。
 */
import type { Message } from "@/types";
import { normaliseTurnId } from "./turn-align.ts";

export type LocateTarget =
  | { kind: "ok"; messageId: string }
  | { kind: "legacy" }
  | { kind: "empty" };

/** 这一轮在消息列表里的第一条（数组本身已按 seq/抵达顺序排好），没有则 null。 */
export function firstMessageOfTurn(
  messages: readonly Message[],
  turnId: string | null | undefined,
): Message | null {
  const key = normaliseTurnId(turnId);
  if (key === null) return null;
  return messages.find((message) => normaliseTurnId(message.turnId) === key) ?? null;
}

/** 会话是否「整条都是老数据」：一条带 turnId 的消息都没有。 */
export function hasNoTurnAttribution(messages: readonly Message[]): boolean {
  return !messages.some((message) => normaliseTurnId(message.turnId) !== null);
}

/**
 * 「定位到正文」入口的可用性 + 原因。
 *
 * legacy = 整个会话没有一条消息有轮归属（M1 之前的数据）；
 * empty  = 会话里已有轮归属，只是这一轮没有正文（或请求的 turnId 为空）。
 */
export function locateTargetOf(
  messages: readonly Message[],
  turnId: string | null | undefined,
): LocateTarget {
  const first = firstMessageOfTurn(messages, turnId);
  if (first) return { kind: "ok", messageId: first.id };
  return hasNoTurnAttribution(messages) ? { kind: "legacy" } : { kind: "empty" };
}

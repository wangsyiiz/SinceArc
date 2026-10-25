/**
 * kind 注册表的前端镜像（唯一一份 TS 来源）。
 *
 * 权威在 Rust：`src-tauri/src/message_kind.rs::REGISTRY`。这里是它的镜像，
 * 两边靠 `message-registry.test.ts` 夹住（扫 Rust 源逐项比对），**不允许只在一边改**。
 *
 * 未登记的 kind 由各消费点按兜底处理：不进聊天区、块按 `none`（即一块一原子）。
 */
import type { MessageKind } from "./ipc/types.gen/MessageKind.ts";

/** 与 Rust `MergeRule` 的序列化值一致。 */
export type MergeRule = "stream" | "tool" | "request" | "none";

export interface KindSpec {
  chat: boolean;
  merge: MergeRule;
}

export const KIND_SPECS = {
  "text.user": { chat: true, merge: "none" },
  "text.agent": { chat: true, merge: "stream" },
  aside: { chat: true, merge: "none" },
  "delegate.card": { chat: true, merge: "none" },
  "notice.system": { chat: true, merge: "none" },
  thought: { chat: false, merge: "stream" },
  tool_call: { chat: false, merge: "tool" },
  tool_call_update: { chat: false, merge: "tool" },
  permission: { chat: false, merge: "request" },
  permission_decision: { chat: false, merge: "request" },
  usage: { chat: false, merge: "none" },
  commands: { chat: false, merge: "none" },
  "delegate.request": { chat: false, merge: "none" },
  "delegate.result": { chat: false, merge: "none" },
} as const satisfies Record<MessageKind, KindSpec>;

export function specOf(kind: string): KindSpec | null {
  return (KIND_SPECS as Record<string, KindSpec>)[kind] ?? null;
}

/** 未登记 → false（兜底：不进聊天区）。 */
export function isChatKind(kind: string): boolean {
  return specOf(kind)?.chat ?? false;
}

/** 未登记 → "none"（兜底：一块一原子，绝不丢）。 */
export function mergeRuleOf(kind: string): MergeRule {
  return specOf(kind)?.merge ?? "none";
}

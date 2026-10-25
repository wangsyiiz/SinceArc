import type { Message } from "@/types";
import { isChatKind } from "./message-registry.ts";

/**
 * 聊天区唯一可见性判定：只认 atom 的权威点号 kind。
 *
 * 未登记 / 非 chat 的 kind 返回 null，组件不渲染；不再从 role / legacy kind 反推。
 */
export function chatVisibilityOf(
  message: Pick<Message, "atomKind">,
): string | null {
  return isChatKind(message.atomKind) ? message.atomKind : null;
}

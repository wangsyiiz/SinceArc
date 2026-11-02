import type { Message } from "@/types";

/**
 * 会话工作目录是否已锁定（docs/desktop-ux.md §45）。
 *
 * 判据只有一条：这个会话里出现过**用户**消息。系统提示、agent 输出都不算 ——
 * 一个刚打开、只有「已连接」提示的会话，目录必须还能改。
 */
export function isCwdLocked(messages: Message[] | null | undefined): boolean {
  return (messages ?? []).some((message) => message.role === "user");
}

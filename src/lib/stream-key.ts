/** 流缓冲键：正文按 ACP 会话 + messageId 归并；缺 id 时保持旧的单槽行为。 */
export function keyOf(acpSid: string, messageId?: string | null): string {
  const id = messageId?.trim();
  return id ? `stream-${acpSid}-${id}` : `stream-${acpSid}`;
}

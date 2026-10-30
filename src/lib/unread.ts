/** 未读定位与徽标文本（docs/desktop-ux.md §42）。 */

export interface UnreadMessageLike {
  id: string;
  role: string;
}

const UNREAD_ROLES = new Set(["player", "system"]);

function isUnreadRole(role: string): boolean {
  return UNREAD_ROLES.has(role);
}

/**
 * 从当前内存消息里定位首条未读消息。
 *
 * 未读数来自库（只算 player/system），内存里可能已经被滑动窗口裁掉更早的部分；
 * 因此从尾部取 `unreadCount` 条可计入未读的消息，再返回其中最靠前的一条。
 * 未读数大于内存条数时，退回当前窗口里第一条可计入未读的消息。
 */
export function firstUnreadMessageId(
  messages: readonly UnreadMessageLike[],
  unreadCount: number,
): string | null {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) return null;
  const eligible = messages.filter((message) => isUnreadRole(message.role));
  if (eligible.length === 0) return null;
  const first = Math.max(0, eligible.length - Math.floor(unreadCount));
  return eligible[first]?.id ?? null;
}

/** 侧栏徽标：0 不显示；1–99 原样；100 起折叠成 99+。 */
export function unreadBadgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const value = Math.floor(count);
  if (value <= 0) return null;
  return value > 99 ? "99+" : String(value);
}

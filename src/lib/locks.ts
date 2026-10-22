/**
 * 写提示的账本。
 *
 * 群聊里每个成员是**独立 ACP 会话**，所以锁必须按 `acpSessionId` 分开记：
 * 用一个槽位存「当前谁在写」的写法，会让 A 解锁时把 B 的提示一起清掉
 * （首版就是这么写的，Codex 在交付时自己指出了这个坑）。
 */
export interface LockInfo {
  playerId: string | null;
  title: string;
  count: number;
}

export interface LockPayload {
  acpSessionId: string;
  playerId: string | null;
  title: string;
  count: number;
}

export function applyLock(
  locks: Record<string, LockInfo>,
  payload: LockPayload,
): Record<string, LockInfo> {
  const next = { ...locks };
  if (payload.count === 0) {
    delete next[payload.acpSessionId];
  } else {
    next[payload.acpSessionId] = {
      playerId: payload.playerId,
      title: payload.title,
      count: payload.count,
    };
  }
  return next;
}

/** 展示用：取一个（按插入顺序第一个）作代表，其余计数 */
export function summarizeLocks(
  locks: Record<string, LockInfo>,
): { playerId: string | null; title: string; extra: number } | null {
  const all = Object.values(locks);
  if (all.length === 0) return null;
  return { playerId: all[0].playerId, title: all[0].title, extra: all.length - 1 };
}

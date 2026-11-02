/**
 * 「这条会话的 agent 是谁」——消息流里主 agent 的名字、颜色都从它来（§41.7）。
 *
 * 为什么不直接用 `activeProfile`：那是「新建会话时默认用哪条连接」，
 * 跟已经存在的会话没有关系。用户完全可以在 codex 会话里把 activeProfile 停在
 * `hermes · fedora`，于是所有回复都顶着 hermes 的名字 —— 本条规则就是为了不再这样。
 *
 * 顺序：会话自己的连接 → 全局默认连接 → 无（调用方退回「agent」字样）。
 * 会话的 profileId 指向已删除的连接时也走兜底，不显示「未知」。
 */
export function resolveAgentProfile<T extends { id: string }>(input: {
  sessionProfileId?: string | null;
  profiles: T[];
  fallback?: T;
}): T | undefined {
  const wanted = input.sessionProfileId?.trim();
  if (wanted) {
    const hit = input.profiles.find((p) => p.id === wanted);
    if (hit) return hit;
  }
  return input.fallback;
}

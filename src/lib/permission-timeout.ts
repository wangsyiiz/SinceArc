/**
 * 本地权限请求超时。
 *
 * 来源：Hermes `tools/approval_context.py` 的 `approvals.timeout` 默认 300 秒；
 * agent 自己超时后会按拒绝继续。客户端计时器用于在 agent 收尾之前就把弹框切成过期态，
 * 避免用户面对一个已经不可能成功的授权框。
 */
export const PERMISSION_CLIENT_TIMEOUT_MS = 300_000;

export function permissionTimerKey(profileId: string, requestId: number): string {
  return `${profileId}:${requestId}`;
}

export interface PermissionTurnSnapshot {
  profileId?: string | null;
  acpSessionId?: string | null;
  turnId?: string | null;
}

export interface PermissionTurnInputs {
  profileId?: string;
  acpSessionId?: string | null;
  turnId?: string | null;
}

/** 快照三项全空时，才允许调用方退回实时激活会话。 */
export function hasPermissionTurnSnapshot(
  snapshot: PermissionTurnSnapshot | null | undefined,
): boolean {
  return Boolean(snapshot?.profileId || snapshot?.acpSessionId || snapshot?.turnId);
}

/**
 * 「放行整轮」的归属解析。
 *
 * 只要请求带了任何一项快照，就整组使用快照，不用当前激活会话补缺：
 * 缺 turnId 时应当报失效并要求重发，而不是把别的会话当成这条请求的归属。
 */
export function resolvePermissionTurn(
  request: PermissionTurnSnapshot | null | undefined,
  live: PermissionTurnInputs,
): PermissionTurnInputs {
  if (!hasPermissionTurnSnapshot(request)) return live;
  return {
    profileId: request?.profileId ?? undefined,
    acpSessionId: request?.acpSessionId ?? null,
    turnId: request?.turnId ?? null,
  };
}

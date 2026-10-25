export type SendTargetDecision = "own" | "create" | "need-connect";

export interface SendTargetInput {
  /** 这条界面会话已经绑定的 ACP 会话 id。 */
  own?: string | null;
  /** 这条界面会话所属的 profile 是否已经连上。 */
  connected: boolean;
}

/**
 * 主 agent 的投递目标只有三种：用自己的 ACP 会话、现建一条、或先连接。
 *
 * `own` 必须来自「这条界面会话」自己的绑定，不能是连接当前会话 ——
 * 后者是进程级的，拿来给新会话首条消息投递就会串上下文。
 */
export function resolveSendTarget({ own, connected }: SendTargetInput): SendTargetDecision {
  if (own) return "own";
  return connected ? "create" : "need-connect";
}

export type SendPlan = "target" | SendTargetDecision;

/** 群里 @ 了成员时永远投成员自己的 ACP 会话，不参与主 agent 的三态判定。 */
export function resolveSendPlan({
  target,
  own,
  connected,
}: {
  target?: unknown;
  own?: string | null;
  connected: boolean;
}): SendPlan {
  if (target) return "target";
  return resolveSendTarget({ own, connected });
}

import type { Activity } from "../types.ts";

/**
 * 聊天区那行「思考中」= `acts` 里 `status === "running"` 的活动行。
 *
 * 用户发起的轮由 `usePrompt` 在发送时创建这一行（id = `act-stream-<acpSid>`）；
 * agent 自发起的轮（docs/acp-turn-synthesis.md §32）不经过发送流程，所以要在合成
 * `PromptStarted(origin=agent)` 到达时补一行 —— 否则正文会「突然冒出来」，没有思考态。
 *
 * 幂等：已经有同 id 且仍在跑的行走原样返回（**同一个数组引用**），
 * 这样调用方可以据此判断「什么都没变」，也不会把 `at` 重置掉
 * （重置会让思考行显示的「已跑时长」每来一个事件就归零）。
 */
export function ensureRunningAct(
  acts: readonly Activity[],
  input: { id: string; playerId: string; title: string; at: string },
): readonly Activity[] {
  const already = acts.some((act) => act.id === input.id && act.status === "running");
  if (already) return acts;

  const next: Activity = {
    id: input.id,
    playerId: input.playerId,
    kind: "thinking",
    title: input.title,
    status: "running",
    at: input.at,
  };
  // 上一轮同 id 的行可能停在 ok/error/stopped：换掉它，别在列表里堆同名行。
  return [...acts.filter((act) => act.id !== input.id), next];
}

/** 活动行 id 的唯一口径；收尾（promptResult）也用它找行。 */
export function streamActId(acpSessionId: string): string {
  return `act-stream-${acpSessionId}`;
}

/**
 * 合成轮让位时发出的 `promptResult(origin=agent)` 不是真轮的终态。
 * 真轮仍在飞（有 sendTrace）时必须忽略它，否则会提前关掉真轮的思考行、清掉 busy。
 */
export function shouldIgnoreAgentResult(
  origin: string | null,
  hasTraceInFlight: boolean,
): boolean {
  return origin === "agent" && hasTraceInFlight;
}

//! 派活域：把任务交给本群成员，并可等待它的终态。

import type { DelegateHandleDto, DelegateOutcomeDto } from "../types";
import { asCmdError, invokeCmd } from "../client";

async function callDelegate<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invokeCmd<T>(cmd, args);
  } catch (e) {
    throw asCmdError(e);
  }
}

/** 派活。`task` 是子任务能看到的全部上下文（task_only 档）。 */
export function delegateTask(
  parentUiSessionId: string,
  targetMemberId: string,
  task: string,
): Promise<DelegateHandleDto> {
  return callDelegate<DelegateHandleDto>("delegate_task", {
    parentUiSessionId,
    targetMemberId,
    task,
  });
}

/** 等结果；超时只返回 `timed_out`，不取消目标任务。 */
export function delegateWait(handleId: string, timeoutMs: number): Promise<DelegateOutcomeDto> {
  return callDelegate<DelegateOutcomeDto>("delegate_wait", { handleId, timeoutMs });
}

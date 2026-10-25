/** promptResult 之后，agent 仍可能继续把命令输出当正文流回来的时间窗口。 */
export const LATE_WINDOW_MS = 5_000;

/** 迟到正文连续静默这么久，就认为这一条回答已经收完。 */
export const LATE_SETTLE_QUIET_MS = 600;

/**
 * 正文是否该接收：正常在飞轮次一律接收；轮终态后的迟到窗口内也接收。
 * 窗口外通常是 `session/load` 的重放，必须拒绝。
 */
export function shouldAcceptChunk(awaiting: boolean, lateUntil: number, now: number): boolean {
  return awaiting || now < lateUntil;
}

/** 迟到流是否已经静默够久，可以 settle 落库。 */
export function shouldSettleLate(
  lastChunkAt: number,
  now: number,
  quietMs: number = LATE_SETTLE_QUIET_MS,
): boolean {
  return now - lastChunkAt >= quietMs;
}

/**
 * 回复音效的「安静窗口」判据（docs/desktop-ux.md §31.3）。
 *
 * 为什么需要它：音效挂在「一轮终态」上，但终态不等于 agent 真的停下了 ——
 * 合成轮的让位结果、群成员各自的轮次、以及某些 agent 先回一个 end_turn 再继续动作，
 * 都会在 agent 还在干活的时候给出一条 promptResult。以前听到的就是这种「提前响」。
 *
 * 做法：终态到达后先不响，等 `REPLY_CHIME_QUIET_MS`；到点再确认这段时间里该会话
 * 没有新的活动事件（正文 / 思考 / 工具调用），才算「有效回应已经落地」。
 */

/** 终态之后要求静默多久才认账（毫秒）。 */
export const REPLY_CHIME_QUIET_MS = 1200;

/**
 * 到点时还该不该响：终态之后**没有任何**更晚的活动事件。
 *
 * `lastActivityAt` 缺失 = 这个会话这段时间一条活动事件都没有 ⇒ 可以响。
 */
export function chimeStillValid(
  finishedAt: number,
  lastActivityAt: number | null | undefined,
): boolean {
  if (lastActivityAt == null) return true;
  return lastActivityAt <= finishedAt;
}

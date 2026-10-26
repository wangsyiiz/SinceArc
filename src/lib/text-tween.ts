export const MIN_RATE_PER_SEC = 120;
export const TAU_SEC = 0.12;
/** 正常收口后允许继续追帧的总预算；停止 / 出错不走这条路，直接拉满。 */
export const SEAL_BUDGET_MS = 600;
/** 收口追帧的观感上限：每帧约一行，免得一大段一次糊上去。 */
export const SEAL_RATE_MAX = 3000;

/**
 * 推进一格显示长度。
 *
 * 流式中（不传 `remainingMs`）：按 R3 的「比例 + 地板」追到达长度 —— 差大加速、差小匀速补，
 * 所以永远不会「看起来卡住」，也永远不越过目标。
 *
 * 收口后（传 `remainingMs`）：改用「按剩余时间配速 + 每帧上限」，不用 R3 速度律 ——
 * `gap / TAU` 会让任何差距都在 ~120ms 内走完，等于把收口又变回一跳。两个约束冲突时截止优先：
 * 剩余 ≤ 0 的那一帧直接拉满（极端大块仍会跳，这是刻意的：宁可在预算内收干净，也不让界面比状态栏慢半拍）。
 */
export function stepTextTween(input: {
  show: number;
  target: number;
  dtMs: number;
  /** 收口后剩余预算（毫秒）。不传 = 仍在流式中。 */
  remainingMs?: number;
}): number {
  const { show, target, remainingMs } = input;
  const gap = target - show;
  if (gap <= 0) return target;

  const dtMs = input.dtMs > 0 ? input.dtMs : 1;

  if (remainingMs !== undefined) {
    if (remainingMs <= 0) return target;
    const needed = Math.ceil((gap * dtMs) / remainingMs);
    const capped = Math.ceil((SEAL_RATE_MAX * dtMs) / 1000);
    return Math.min(target, show + Math.max(1, Math.min(needed, capped)));
  }

  const speed = Math.max(MIN_RATE_PER_SEC, gap / TAU_SEC);
  const delta = Math.max(1, Math.ceil((speed * dtMs) / 1000));
  return Math.min(target, show + delta);
}

export function safeCut(text: string, index: number): number {
  const cut = Math.max(0, Math.min(text.length, Math.trunc(index)));
  if (cut === 0 || cut === text.length) return cut;

  const previous = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  const splitsPair =
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff;
  return splitsPair ? cut - 1 : cut;
}

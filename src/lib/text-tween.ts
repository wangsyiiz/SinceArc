export const MIN_RATE_PER_SEC = 120;
export const TAU_SEC = 0.12;

export function stepTextTween(input: {
  show: number;
  target: number;
  dtMs: number;
}): number {
  const { show, target } = input;
  const gap = target - show;
  if (gap <= 0) return target;

  const dtMs = input.dtMs > 0 ? input.dtMs : 1;
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

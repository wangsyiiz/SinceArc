export type TooltipSide = "above" | "below";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Tooltip 定位：优先在锚点上方，上方放不下（越界或剩余空间更小）时翻到下方；
 * 水平方向按锚点中心对齐，并留出视口左右各 8px。
 */
export function computeTooltipPosition(input: {
  anchor: { top: number; left: number; width: number; height: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  /** 与锚点的间距，默认 6 */
  gap?: number;
}): { top: number; left: number; side: TooltipSide } {
  const gap = input.gap ?? 6;
  const margin = 8;
  const { anchor, size, viewport } = input;

  const aboveTop = anchor.top - gap - size.height;
  const belowTop = anchor.top + anchor.height + gap;
  const aboveSpace = anchor.top - gap;
  const belowSpace = viewport.height - (anchor.top + anchor.height + gap);
  const aboveFits = aboveTop >= 0;
  const belowFits = belowTop + size.height <= viewport.height;

  let side: TooltipSide;
  if (aboveFits && (aboveSpace >= belowSpace || !belowFits)) {
    side = "above";
  } else if (belowFits) {
    side = "below";
  } else {
    side = aboveSpace >= belowSpace ? "above" : "below";
  }

  const rawLeft = anchor.left + anchor.width / 2 - size.width / 2;
  const maxLeft = viewport.width - margin - size.width;
  const left =
    maxLeft < margin ? Math.max(0, Math.min(rawLeft, viewport.width - size.width)) : clamp(rawLeft, margin, maxLeft);

  const rawTop = side === "above" ? aboveTop : belowTop;
  const maxTop = Math.max(0, viewport.height - size.height);
  const top = clamp(rawTop, 0, maxTop);

  return { top, left, side };
}

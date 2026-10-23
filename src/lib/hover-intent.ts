export type HoverSide = "left" | "right";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 计算悬停卡片的位置。卡片优先贴在锚点左侧，左侧放不下才翻到右侧；
 * 垂直方向与锚点顶端对齐，但要留出视口上下各 8px 的边距。
 */
export function computeHoverPosition(args: {
  anchor: { top: number; left: number; right: number; bottom: number };
  viewport: { width: number; height: number };
  width: number;
  gap?: number;
  maxCard?: number;
}): { left: number; top: number; side: HoverSide; maxHeight: number } {
  const gap = args.gap ?? 8;
  const margin = 8;
  const maxCard = args.maxCard ?? 360;

  const leftCandidate = args.anchor.left - gap - args.width;
  const side: HoverSide = leftCandidate >= margin ? "left" : "right";
  const rawLeft = side === "left" ? leftCandidate : args.anchor.right + gap;
  const maxLeft = args.viewport.width - margin - args.width;
  const left = maxLeft < margin ? margin : clamp(rawLeft, margin, maxLeft);

  const maxHeight = Math.max(0, Math.min(maxCard, args.viewport.height - margin * 2));
  const maxTop = Math.max(margin, args.viewport.height - margin - maxHeight);
  const top = clamp(args.anchor.top, margin, maxTop);

  return { left, top, side, maxHeight };
}

export type Rect = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Placement = "below" | "above";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 浮层位置：优先 prefer 那侧，放不下翻到另一侧，两侧都放不下取空间大的一侧并夹进视口；
 * 水平按 align 对齐后夹进 [margin, viewport.width - margin - panel.width]。
 */
export function computeLayerPosition(args: {
  trigger: Rect;
  panel: Size;
  viewport: Size;
  gap?: number;
  margin?: number;
  prefer?: Placement;
  align?: "start" | "end";
}): { top: number; left: number; placement: Placement } {
  const gap = args.gap ?? 6;
  const margin = args.margin ?? 8;
  const prefer = args.prefer ?? "below";
  const align = args.align ?? "start";

  const belowTop = args.trigger.top + args.trigger.height + gap;
  const belowFits = belowTop + args.panel.height <= args.viewport.height - margin;
  const aboveTop = args.trigger.top - gap - args.panel.height;
  const aboveFits = aboveTop >= margin;

  let placement: Placement;
  if (prefer === "below") {
    if (belowFits) placement = "below";
    else if (aboveFits) placement = "above";
    else placement = belowSpace(args) >= aboveSpace(args) ? "below" : "above";
  } else if (aboveFits) {
    placement = "above";
  } else if (belowFits) {
    placement = "below";
  } else {
    placement = aboveSpace(args) >= belowSpace(args) ? "above" : "below";
  }

  const maxTop = Math.max(margin, args.viewport.height - margin - args.panel.height);
  const rawTop = placement === "below" ? belowTop : aboveTop;
  const top = clamp(rawTop, margin, maxTop);

  const rawLeft =
    align === "start"
      ? args.trigger.left
      : args.trigger.left + args.trigger.width - args.panel.width;
  const maxLeft = args.viewport.width - margin - args.panel.width;
  const left = maxLeft < margin ? margin : clamp(rawLeft, margin, maxLeft);

  return { top, left, placement };
}

function belowSpace(args: { trigger: Rect; viewport: Size; gap?: number; margin?: number }): number {
  const gap = args.gap ?? 6;
  const margin = args.margin ?? 8;
  return args.viewport.height - margin - (args.trigger.top + args.trigger.height + gap);
}

function aboveSpace(args: { trigger: Rect; gap?: number; margin?: number }): number {
  const gap = args.gap ?? 6;
  const margin = args.margin ?? 8;
  return args.trigger.top - gap - margin;
}

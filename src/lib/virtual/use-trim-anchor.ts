import { useLayoutEffect, useRef, type RefObject } from "react";
import { planWindow, type WindowPlan } from "../messages-window.ts";
import type { VirtualRow } from "./useVirtualList.ts";

export interface VisibleIndexRange {
  firstVisible: number;
  lastVisible: number;
}

interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
}

/** The virtualizer includes overscan rows; only use rows intersecting the viewport. */
export function visibleIndexRange(
  rows: readonly VirtualRow[],
  metrics: ScrollMetrics,
): VisibleIndexRange | null {
  if (rows.length === 0 || metrics.clientHeight <= 0) return null;
  const top = metrics.scrollTop;
  const bottom = top + metrics.clientHeight;
  let firstVisible = -1;
  let lastVisible = -1;

  for (const row of rows) {
    const rowEnd = row.start + row.size;
    if (rowEnd <= top) continue;
    if (row.start >= bottom) break;
    if (firstVisible < 0) firstVisible = row.index;
    lastVisible = row.index;
  }

  if (firstVisible < 0) return null;
  return { firstVisible, lastVisible };
}

function compensatedScrollTop(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
  clientHeight: number,
): number {
  const max = Math.max(0, nextHeight - clientHeight);
  const next = previousTop - (previousHeight - nextHeight);
  return Math.max(0, Math.min(max, next));
}

export interface UseTrimAnchorOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  rows: readonly VirtualRow[];
  count: number;
  /** Session identity: skip the first commit so mount-time scroll-to-bottom can settle. */
  scopeKey?: string | null;
  pinned: readonly number[];
  onTrim: (plan: WindowPlan) => void;
}

/**
 * Trim the message window after a virtual-row update and keep the visible row
 * anchored. The state update is synchronous enough for the next frame to read
 * the new content height; we only compensate here, never inside useVirtualList.
 */
export function useTrimAnchor({
  scrollRef,
  rows,
  count,
  scopeKey,
  pinned,
  onTrim,
}: UseTrimAnchorOptions): void {
  const frameRef = useRef<number | null>(null);
  const seenScopeRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (frameRef.current !== null) return;
    const scope = scopeKey ?? "";
    if (seenScopeRef.current !== scope) {
      seenScopeRef.current = scope;
      return;
    }
    const box = scrollRef.current;
    if (!box) return;
    const range = visibleIndexRange(rows, box);
    if (!range) return;

    const plan = planWindow({ count, ...range, pinned });
    if (plan.dropHead === 0 && plan.dropTail === 0) return;

    const previousTop = box.scrollTop;
    const previousHeight = box.scrollHeight;
    onTrim(plan);

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const next = scrollRef.current;
      if (!next) return;
      const nextTop =
        plan.dropHead > 0
          ? compensatedScrollTop(
              previousTop,
              previousHeight,
              next.scrollHeight,
              next.clientHeight,
            )
          : previousTop;
      const max = Math.max(0, next.scrollHeight - next.clientHeight);
      next.scrollTop = Math.max(0, Math.min(max, nextTop));
    });
  }, [count, onTrim, pinned, rows, scopeKey, scrollRef]);

  useLayoutEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
}

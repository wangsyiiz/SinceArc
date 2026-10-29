import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
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
  /** 锚点补偿进行中：先欠着，等补偿落定后的下一帧再裁。 */
  blocked?: boolean;
  diag?: (tag: string, text: string) => void;
  /** 裁剪也会改 scrollHeight/scrollTop，先进入程序化滚动保护窗。 */
  onProgrammaticScroll?: () => void;
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
  blocked = false,
  diag,
  onProgrammaticScroll,
  onTrim,
}: UseTrimAnchorOptions): void {
  const frameRef = useRef<number | null>(null);
  const retryFrameRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const seenScopeRef = useRef<string | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const latestRef = useRef({
    scrollRef,
    rows,
    count,
    scopeKey,
    pinned,
    diag,
    onProgrammaticScroll,
    onTrim,
  });
  latestRef.current = {
    scrollRef,
    rows,
    count,
    scopeKey,
    pinned,
    diag,
    onProgrammaticScroll,
    onTrim,
  };

  const runTrim = useCallback(() => {
    if (frameRef.current !== null) {
      pendingRef.current = true;
      return;
    }
    pendingRef.current = false;
    const latest = latestRef.current;
    const scope = latest.scopeKey ?? "";
    if (seenScopeRef.current !== scope) {
      seenScopeRef.current = scope;
      return;
    }
    const box = latest.scrollRef.current;
    if (!box) return;
    const range = visibleIndexRange(latest.rows, box);
    if (!range) return;

    const plan = planWindow({
      count: latest.count,
      ...range,
      pinned: latest.pinned,
      diag: latest.diag,
    });
    if (plan.dropHead === 0 && plan.dropTail === 0) return;

    const previousTop = box.scrollTop;
    const previousHeight = box.scrollHeight;
    latest.diag?.(
      "WINDOW-TRIM",
      `head=${plan.dropHead} tail=${plan.dropTail} top=${previousTop} h=${previousHeight}`,
    );
    latest.onProgrammaticScroll?.();
    latest.onTrim(plan);

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const next = latest.scrollRef.current;
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
  }, []);

  const schedulePending = useCallback(() => {
    if (retryFrameRef.current !== null) return;
    function tick() {
      retryFrameRef.current = null;
      if (blockedRef.current) {
        pendingRef.current = true;
        return;
      }
      if (frameRef.current !== null) {
        pendingRef.current = true;
        retryFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      runTrim();
    }
    retryFrameRef.current = requestAnimationFrame(tick);
  }, [runTrim]);

  useLayoutEffect(() => {
    if (blocked) {
      pendingRef.current = true;
      return;
    }
    // 欠账或已有补算帧：等到下一帧用最新数据再算。
    if (pendingRef.current || retryFrameRef.current !== null) {
      pendingRef.current = true;
      schedulePending();
      return;
    }
    // 上一次裁剪的 scrollTop 补偿还没落定，等下一次布局变化再裁。
    if (frameRef.current !== null) return;
    runTrim();
  }, [blocked, count, diag, onTrim, pinned, rows, runTrim, schedulePending, scopeKey, scrollRef]);

  useLayoutEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (retryFrameRef.current !== null) cancelAnimationFrame(retryFrameRef.current);
    },
    [],
  );
}

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  anchorTargetScrollTop,
  isAtBottom,
  isTailChange,
  shouldFollowBottom,
} from "./virtual-math.ts";

export interface VirtualRow {
  key: string;
  index: number;
  start: number;
  size: number;
}

export interface UseVirtualListOptions {
  count: number;
  keyOf: (index: number) => string;
  estimate: (index: number) => number;
  scrollRef: RefObject<HTMLDivElement | null>;
  overscan?: number;
  stickToBottom?: boolean;
  diag?: (tag: string, text: string) => void;
}

interface AnchorSnapshot {
  index: number;
  key: string;
  /** 行顶相对滚动容器顶部的真实偏移，可能为负（行在视口上方）。 */
  offsetTop: number;
}

export function useVirtualList(opts: UseVirtualListOptions) {
  const {
    count,
    keyOf,
    estimate,
    scrollRef,
    overscan = 6,
    stickToBottom = false,
    diag,
  } = opts;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    getItemKey: keyOf,
    overscan,
  });

  const [atBottom, setAtBottom] = useState(true);
  const lastTotal = useRef<number | null>(null);
  const anchorRef = useRef<AnchorSnapshot | null>(null);
  /** 锚定恢复进行中：这期间的条数/总高变化一律不触发贴底跟随 */
  const shiftingRef = useRef(false);
  const [adjusting, setAdjusting] = useState(false);
  /** 程序化滚动的保护窗：窗口内滚动事件只许把 atBottom 置 false。 */
  const programmaticUntil = useRef(0);
  const tailKeyRef = useRef<string | null>(null);
  const anchorFrameRef = useRef<number | null>(null);
  const totalSize = virtualizer.getTotalSize();

  const markProgrammatic = useCallback(() => {
    programmaticUntil.current = Date.now() + 120;
  }, []);

  /** ref 与 state 双写：state 只在切换时更新，App 不会因为每帧滚动而重渲染。 */
  const setShifting = useCallback((next: boolean) => {
    if (shiftingRef.current === next) return;
    shiftingRef.current = next;
    setAdjusting(next);
  }, []);
  const isAdjusting = useCallback(() => shiftingRef.current, []);

  const scrollToEnd = useCallback(() => {
    if (count === 0) return;
    markProgrammatic();
    virtualizer.scrollToEnd();
  }, [count, markProgrammatic, virtualizer]);

  /**
   * 用户主动发起的跳底（docs/desktop-ux.md §27.2）：发消息后**无条件**回到底部。
   *
   * 不能只调 `scrollToEnd()`：贴底跟随的条件是 `stickToBottom && atBottom`，
   * 上翻读历史时 `atBottom=false`，新消息追加后一个 effect 都不动 —— 自己刚发的那条看不见。
   * 所以这里顺手把 `atBottom` 置回 true，让后续的跟随逻辑重新成立。
   *
   * 调用方负责下一帧再调一次：虚拟列表的行高是估算的，刚追加那一行要等一次 measure。
   */
  const forceScrollToEnd = useCallback(() => {
    setAtBottom(true);
    scrollToEnd();
  }, [scrollToEnd]);

  const scrollToIndex = useCallback(
    (index: number, align: "start" | "center" | "end" = "start") => {
      if (count === 0) return;
      virtualizer.scrollToIndex(index, { align });
    },
    [count, virtualizer],
  );

  // 贴底跟随（条数变化）：只有**尾部变了**才算新消息；前插（加载更早）不许跟随，
  // 否则点一次「加载更早」就被拽回底部。
  useEffect(() => {
    const nextTail = count === 0 ? null : keyOf(count - 1);
    const tailChanged = isTailChange(tailKeyRef.current, nextTail);
    tailKeyRef.current = nextTail;
    if (shiftingRef.current) return;
    if (Date.now() < programmaticUntil.current) return;
    if (!tailChanged) return;
    if (count === 0) return;
    if (!shouldFollowBottom(stickToBottom, atBottom)) return;
    diag?.("FOLLOW-END", "reason=tail");
    scrollToEnd();
  }, [atBottom, count, diag, keyOf, scrollToEnd, stickToBottom]);

  // 贴底跟随（总高变化）：流式补间 / 卡片展开时条数不变但高度在长。
  // 锚定恢复期间跳过 —— 那种变化来自上方前插，跟随会把用户拽到底部。
  useEffect(() => {
    if (lastTotal.current === totalSize) return;
    lastTotal.current = totalSize;
    if (shiftingRef.current) return;
    if (Date.now() < programmaticUntil.current) return;
    if (count === 0) return;
    if (!shouldFollowBottom(stickToBottom, atBottom)) return;
    diag?.("FOLLOW-END", "reason=total");
    scrollToEnd();
  }, [atBottom, count, diag, scrollToEnd, stickToBottom, totalSize]);

  // 用户上翻后 atBottom=false，上面两个 effect 都不会再改 scrollTop。
  // 注意：列表是条件渲染的，挂载那一刻 scrollRef.current 可能还是 null；
  // 只依赖 [scrollRef] 会「挂一次失败就再也不挂」，atBottom 永远停在 true，
  // 表现为「上翻之后来新消息被拽回底部」。所以从空到有内容时再挂一次。
  const hasContent = count > 0;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const onScroll = () => {
      const next = isAtBottom(box);
      if (next && Date.now() < programmaticUntil.current) return;
      setAtBottom((current) => (current === next ? current : next));
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => box.removeEventListener("scroll", onScroll);
  }, [hasContent, scrollRef]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    if (isAtBottom(box)) return;
    setAtBottom((current) => (current ? false : current));
  }, [count, scrollRef, totalSize]);

  const findElement = useCallback((box: HTMLElement, index: number) => {
    return box.querySelector<HTMLElement>(`[data-index="${index}"]`);
  }, []);

  const offsetInContainer = useCallback((box: HTMLElement, el: HTMLElement) => {
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }, []);

  const beginAnchorShift = useCallback(
    (index: number) => {
      if (anchorFrameRef.current !== null) {
        cancelAnimationFrame(anchorFrameRef.current);
        anchorFrameRef.current = null;
      }
      anchorRef.current = null;
      const box = scrollRef.current;
      if (!box) return;
      const el = findElement(box, index);
      if (!el) return;
      markProgrammatic();
      setShifting(true);
      anchorRef.current = {
        index,
        key: keyOf(index),
        offsetTop: offsetInContainer(box, el),
      };
    },
    [findElement, keyOf, markProgrammatic, offsetInContainer, scrollRef, setShifting],
  );

  const endAnchorShift = useCallback(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor) {
      setShifting(false);
      return;
    }

    if (anchorFrameRef.current !== null) {
      cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = null;
    }

    let alignedIndex = -1;
    for (let index = 0; index < count; index += 1) {
      if (keyOf(index) === anchor.key) {
        alignedIndex = index;
        break;
      }
    }
    // 锚点行被裁掉了：位置交给 use-trim-anchor 的补偿，这里绝不再跳。
    if (alignedIndex < 0) {
      setShifting(false);
      diag?.("WINDOW-ANCHOR-LOST", `count=${count} anchor=${anchor.key}`);
      return;
    }

    anchorFrameRef.current = requestAnimationFrame(() => {
      markProgrammatic();
      const box = scrollRef.current;
      if (!box) {
        setShifting(false);
        return;
      }

      // 先按库的 start 对齐把目标行带到已知位置，再补上它原本在视口里的偏移。
      virtualizer.scrollToIndex(alignedIndex, { align: "start" });
      virtualizer.cancelScroll();
      box.scrollTop = anchorTargetScrollTop(box.scrollTop, 0, anchor.offsetTop);

      anchorFrameRef.current = requestAnimationFrame(() => {
        markProgrammatic();
        const settledBox = scrollRef.current;
        if (!settledBox) {
          setShifting(false);
          return;
        }
        const row = findElement(settledBox, alignedIndex);
        if (!row) {
          setShifting(false);
          return;
        }
        const currentOffset = offsetInContainer(settledBox, row);
        const target = anchorTargetScrollTop(
          settledBox.scrollTop,
          currentOffset,
          anchor.offsetTop,
        );
        if (Math.abs(target - settledBox.scrollTop) > 0.5) settledBox.scrollTop = target;
        setShifting(false);
      });
    });
  }, [
    count,
    diag,
    findElement,
    keyOf,
    markProgrammatic,
    offsetInContainer,
    scrollRef,
    setShifting,
    virtualizer,
  ]);

  useEffect(
    () => () => {
      if (anchorFrameRef.current !== null) cancelAnimationFrame(anchorFrameRef.current);
    },
    [],
  );

  const rows: VirtualRow[] = virtualizer.getVirtualItems().map((row) => ({
    key: String(row.key),
    index: row.index,
    start: row.start,
    size: row.size,
  }));

  return {
    rows,
    totalSize,
    measureRow: virtualizer.measureElement,
    scrollToIndex,
    scrollToEnd,
    forceScrollToEnd,
    atBottom,
    adjusting,
    isAdjusting,
    beginProgrammaticScroll: markProgrammatic,
    beginAnchorShift,
    endAnchorShift,
  };
}

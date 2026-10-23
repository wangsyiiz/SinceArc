import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computeHoverPosition, type HoverSide } from "@/lib/hover-intent";

const OPEN_DELAY = 220;
const CLOSE_DELAY = 140;
const CARD_WIDTH = 340;

interface CardPosition {
  top: number;
  left: number;
  side: HoverSide;
  maxHeight: number;
}

export function useHoverCard(opts: { disabled?: boolean } = {}): {
  triggerProps: (el: Element | null) => {
    onPointerEnter: (event: React.PointerEvent) => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  };
  card: (content: ReactNode) => ReactNode;
} {
  const disabled = opts.disabled ?? false;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CardPosition | null>(null);
  const anchorRef = useRef<Element | null>(null);
  const focusedRef = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpen = () => {
    if (openTimer.current === null) return;
    clearTimeout(openTimer.current);
    openTimer.current = null;
  };

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const closeNow = () => {
    cancelOpen();
    cancelClose();
    anchorRef.current = null;
    setOpen(false);
    setPosition(null);
  };

  const scheduleClose = () => {
    if (!open || closeTimer.current !== null) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      anchorRef.current = null;
      setOpen(false);
      setPosition(null);
    }, CLOSE_DELAY);
  };

  const measureAndOpen = (el: Element) => {
    const rect = el.getBoundingClientRect();
    setPosition(
      computeHoverPosition({
        anchor: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        width: CARD_WIDTH,
      }),
    );
    setOpen(true);
  };

  const scheduleOpen = (el: Element) => {
    if (disabled) return;
    cancelClose();
    if (open) return;
    cancelOpen();
    anchorRef.current = el;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      const current = anchorRef.current;
      if (current) measureAndOpen(current);
    }, OPEN_DELAY);
  };

  useEffect(() => {
    if (!disabled) return;
    closeNow();
  }, [disabled]);

  useEffect(() => () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && cardRef.current?.contains(event.target)) return;
      closeNow();
    };
    const onResize = () => closeNow();
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const triggerProps = (el: Element | null) => ({
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "touch" || !el) return;
      scheduleOpen(el);
    },
    onPointerLeave: () => {
      cancelOpen();
      if (!focusedRef.current) scheduleClose();
    },
    onFocus: () => {
      focusedRef.current = true;
      if (el) scheduleOpen(el);
    },
    onBlur: () => {
      focusedRef.current = false;
      cancelOpen();
      scheduleClose();
    },
  });

  const card = (content: ReactNode): ReactNode => {
    if (!open || !position) return null;
    /* 一律挂到 body：`position: fixed` 只在「祖先没有 transform / filter / backdrop-filter /
       contain」时才相对视口定位。轨迹面板里这两种可能有 —— 面板外层 overflow-hidden，
       行又落在玻璃容器里，一旦某个祖先带上 backdrop-filter，卡片就会变成相对那个祖先定位并被裁掉。
       portal 之后所有调用点（DOM 行、SVG 图节点）走同一条路，不用逐处判断祖先。 */
    return createPortal(
      <div
        ref={cardRef}
        role="tooltip"
        className="sc-glass pointer-events-auto overflow-y-auto rounded-card p-3 text-caption text-ink-2"
        style={{
          position: "fixed",
          top: position.top,
          left: position.left,
          width: CARD_WIDTH,
          maxHeight: position.maxHeight,
          zIndex: "var(--z-popover)",
          animation: "sc-pop 150ms var(--ease-pop)",
        }}
        onPointerEnter={(event) => {
          event.stopPropagation();
          cancelClose();
        }}
        onPointerLeave={(event) => {
          event.stopPropagation();
          if (!focusedRef.current) scheduleClose();
        }}
      >
        {content}
      </div>,
      document.body,
    );
  };

  return { triggerProps, card };
}

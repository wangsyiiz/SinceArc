import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computeTooltipPosition, type TooltipSide } from "@/lib/tooltip-position";

const OPEN_DELAY = 220;
const CLOSE_DELAY = 140;

type TriggerElementProps = {
  onPointerEnter?: React.PointerEventHandler<Element>;
  onPointerLeave?: React.PointerEventHandler<Element>;
  onFocus?: React.FocusEventHandler<Element>;
  onBlur?: React.FocusEventHandler<Element>;
  "aria-describedby"?: string;
};

export interface TooltipTriggerProps {
  onPointerEnter: React.PointerEventHandler<Element>;
  onPointerLeave: React.PointerEventHandler<Element>;
  onFocus: React.FocusEventHandler<Element>;
  onBlur: React.FocusEventHandler<Element>;
  "aria-describedby": string;
}

interface TooltipPosition {
  top: number;
  left: number;
  side: TooltipSide;
  ready: boolean;
}

let activeTooltipId: string | null = null;
let activeTooltipClose: (() => void) | null = null;

function mergeDescribedBy(existing: string | undefined, id: string): string {
  if (!existing) return id;
  const ids = existing.split(/\s+/).filter(Boolean);
  return ids.includes(id) ? existing : `${existing} ${id}`;
}

export function useTooltip({ label }: { label: string }): {
  triggerProps: TooltipTriggerProps;
  tooltip: ReactNode;
} {
  const reactId = useId();
  const tooltipId = `sc-tooltip-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const anchorRef = useRef<Element | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);
  const openRef = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpen = useCallback(() => {
    if (openTimer.current === null) return;
    clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const closeNow = useCallback(() => {
    cancelOpen();
    cancelClose();
    anchorRef.current = null;
    openRef.current = false;
    setOpen(false);
    setPosition(null);
    if (activeTooltipId === tooltipId) {
      activeTooltipId = null;
      activeTooltipClose = null;
    }
  }, [cancelClose, cancelOpen, tooltipId]);

  const activate = useCallback(() => {
    const previousId = activeTooltipId;
    const previousClose = activeTooltipClose;
    activeTooltipId = tooltipId;
    activeTooltipClose = closeNow;
    if (previousId !== null && previousId !== tooltipId) previousClose?.();
    openRef.current = true;
    setOpen(true);
  }, [closeNow, tooltipId]);

  const showNow = (anchor: Element) => {
    cancelOpen();
    cancelClose();
    anchorRef.current = anchor;
    activate();
  };

  const scheduleOpen = (anchor: Element) => {
    cancelClose();
    if (openRef.current) return;
    cancelOpen();
    anchorRef.current = anchor;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      if (anchorRef.current) activate();
    }, OPEN_DELAY);
  };

  const scheduleClose = useCallback(() => {
    if (!openRef.current || closeTimer.current !== null) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      closeNow();
    }, CLOSE_DELAY);
  }, [closeNow]);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tooltipRef.current;
    if (!anchor || !tip) return;
    const rect = anchor.getBoundingClientRect();
    const next = computeTooltipPosition({
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      size: { width: tip.offsetWidth, height: tip.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    setPosition({ ...next, ready: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [label, measure, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNow();
    };
    const onScroll = () => closeNow();
    const onResize = () => measure();

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [closeNow, measure, open]);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
      if (activeTooltipId === tooltipId) {
        activeTooltipId = null;
        activeTooltipClose = null;
      }
    },
    [cancelClose, cancelOpen, tooltipId],
  );

  const triggerProps: TooltipTriggerProps = {
    "aria-describedby": tooltipId,
    onPointerEnter: (event) => {
      if (event.pointerType === "touch") {
        cancelOpen();
        return;
      }
      scheduleOpen(event.currentTarget);
    },
    onPointerLeave: () => {
      cancelOpen();
      if (focusedRef.current) return;
      scheduleClose();
    },
    onFocus: (event) => {
      if (!event.currentTarget.matches(":focus-visible")) return;
      focusedRef.current = true;
      showNow(event.currentTarget);
    },
    onBlur: () => {
      focusedRef.current = false;
      cancelOpen();
      scheduleClose();
    },
  };

  const tooltip = open
    ? createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="sc-tooltip sc-glass text-caption text-ink-2"
          style={{
            position: "fixed",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position?.ready ? "visible" : "hidden",
            zIndex: "var(--z-popover)",
          }}
        >
          {label}
        </div>,
        document.body,
      )
    : null;

  return { triggerProps, tooltip };
}

export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const { triggerProps, tooltip } = useTooltip({ label });
  const childProps = children.props as TriggerElementProps;
  const mergedProps: TriggerElementProps = {
    ...triggerProps,
    onPointerEnter: (event) => {
      childProps.onPointerEnter?.(event);
      triggerProps.onPointerEnter(event);
    },
    onPointerLeave: (event) => {
      childProps.onPointerLeave?.(event);
      triggerProps.onPointerLeave(event);
    },
    onFocus: (event) => {
      childProps.onFocus?.(event);
      triggerProps.onFocus(event);
    },
    onBlur: (event) => {
      childProps.onBlur?.(event);
      triggerProps.onBlur(event);
    },
    "aria-describedby": mergeDescribedBy(
      childProps["aria-describedby"],
      triggerProps["aria-describedby"],
    ),
  };

  return (
    <>
      {cloneElement(children, mergedProps)}
      {tooltip}
    </>
  );
}

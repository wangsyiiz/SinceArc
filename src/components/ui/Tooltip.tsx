import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
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

interface UseTooltipOptions {
  label: string;
  /** 传入后由调用方控制展开；不传则保持原有的内部状态管理。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 固定展开的 Hint 用；不传就不输出 aria-live。 */
  ariaLive?: "off" | "polite" | "assertive";
}

export interface UseTooltipResult {
  triggerProps: TooltipTriggerProps;
  tooltip: ReactNode;
  tooltipId: string;
  tooltipRef: RefObject<HTMLDivElement | null>;
  showNow: (anchor: Element) => void;
  closeNow: () => void;
}

let activeTooltipId: string | null = null;
let activeTooltipClose: (() => void) | null = null;

function mergeDescribedBy(existing: string | undefined, id: string): string {
  if (!existing) return id;
  const ids = existing.split(/\s+/).filter(Boolean);
  return ids.includes(id) ? existing : `${existing} ${id}`;
}

export function useTooltip({
  label,
  open: controlledOpen,
  onOpenChange,
  ariaLive,
}: UseTooltipOptions): UseTooltipResult {
  const reactId = useId();
  const tooltipId = `sc-tooltip-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const anchorRef = useRef<Element | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);
  const openRef = useRef(open);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  openRef.current = open;

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
    if (controlledOpen !== undefined) {
      if (openRef.current) onOpenChange?.(false);
      return;
    }
    anchorRef.current = null;
    openRef.current = false;
    setUncontrolledOpen(false);
    setPosition(null);
    if (activeTooltipId === tooltipId) {
      activeTooltipId = null;
      activeTooltipClose = null;
    }
  }, [cancelClose, cancelOpen, controlledOpen, onOpenChange, tooltipId]);

  const requestOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen !== undefined) {
        if (next !== openRef.current) onOpenChange?.(next);
        return;
      }
      openRef.current = next;
      setUncontrolledOpen(next);
    },
    [controlledOpen, onOpenChange],
  );

  const activate = useCallback(() => {
    const previousId = activeTooltipId;
    const previousClose = activeTooltipClose;
    activeTooltipId = tooltipId;
    activeTooltipClose = closeNow;
    if (previousId !== null && previousId !== tooltipId) previousClose?.();
    requestOpen(true);
  }, [closeNow, requestOpen, tooltipId]);

  const showNow = useCallback(
    (anchor: Element) => {
      cancelOpen();
      cancelClose();
      anchorRef.current = anchor;
      activate();
    },
    [activate, cancelClose, cancelOpen],
  );

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
    if (open) return;
    anchorRef.current = null;
    setPosition(null);
    if (activeTooltipId === tooltipId) {
      activeTooltipId = null;
      activeTooltipClose = null;
    }
  }, [open, tooltipId]);

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
          aria-live={ariaLive}
          className="sc-tooltip text-caption text-ink-2"
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

  return { triggerProps, tooltip, tooltipId, tooltipRef, showNow, closeNow };
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

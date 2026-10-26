import { Info } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { hintReducer, INITIAL_HINT_STATE } from "@/lib/hint-state";
import { useTooltip } from "./Tooltip";

export function Hint(props: {
  /** 说明正文，≤160 字；超出应当在调用处改走 HoverCard */
  text: string;
  /** 被说明的对象名，用于 aria-label：「<label> 说明」 */
  label: string;
  className?: string;
}): ReactElement {
  const { text, label, className } = props;
  const [state, dispatch] = useReducer(hintReducer, INITIAL_HINT_STATE);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const onOpenChange = useCallback((open: boolean) => {
    dispatch({ type: open ? "open-request" : "close-request" });
  }, []);

  const { triggerProps, tooltip, tooltipId, tooltipRef, showNow, closeNow } = useTooltip({
    label: text,
    open: state.open,
    onOpenChange,
    ariaLive: state.pinned ? "polite" : undefined,
  });

  useEffect(() => {
    if (!state.open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dispatch({ type: "dismiss" });
      closeNow();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;

      const tip = tooltipRef.current;
      if (tip?.contains(target)) return;
      if (tip) {
        /* .sc-tooltip 是 pointer-events:none；点到它上面时 target 会是下层元素，
           所以按视口坐标兜住「点在浮层上」这一种情况。 */
        const rect = tip.getBoundingClientRect();
        if (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        ) {
          return;
        }
      }

      dispatch({ type: "dismiss" });
      closeNow();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [closeNow, state.open, tooltipRef]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${label} 说明`}
        aria-expanded={state.pinned}
        aria-controls={tooltipId}
        {...triggerProps}
        onClick={(event) => {
          const wasPinned = state.pinned;
          dispatch({ type: "toggle-pin" });
          if (wasPinned) closeNow();
          else showNow(event.currentTarget);
        }}
        className={cn(
          "inline-grid size-3.5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1",
          className,
        )}
      >
        <Info aria-hidden="true" className="size-3" />
      </button>
      {tooltip}
    </>
  );
}

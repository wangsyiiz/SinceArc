import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { computeLayerPosition, type Placement } from "@/lib/anchored";
import { cn } from "@/lib/utils";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  description?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect?: () => void;
}

export interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  section?: string;
  description?: string;
  align?: "start" | "end";
  compact?: boolean;
  /**
   * 触发器的形态：
   * - `control`（默认）独立的次按钮，自带底与描边；
   * - `ghost` 行内触发器（状态栏的模式选择、会话条目上的 ⋯）：**无底无边**，
   *   只靠 hover 面与字色变化 —— 暗色下多一圈 1px 框就是规范禁止的那种「用边框分界」。
   */
  triggerVariant?: "control" | "ghost";
  /**
   * 菜单项字号：默认 `ui-tight`（11.5，与存量菜单一致）。
   * 单行短语的图标菜单（如会话条目上的 ⋯）用 `caption`（11）。
   */
  itemSize?: "caption" | "ui-tight";
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  ariaLabel?: string;
}

interface LayerPosition {
  top: number;
  left: number;
  ready: boolean;
}

export function useAnchoredLayer(opts: {
  align?: "start" | "end";
  prefer?: Placement;
}): {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggle: () => void;
  style: {
    top: number;
    left: number;
    visibility: "hidden" | "visible";
    position: "fixed";
  };
} {
  const align = opts.align ?? "start";
  const prefer = opts.prefer ?? "below";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<LayerPosition>({ top: 0, left: 0, ready: false });

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const triggerRect = trigger.getBoundingClientRect();
    const next = computeLayerPosition({
      trigger: {
        top: triggerRect.top,
        left: triggerRect.left,
        width: triggerRect.width,
        height: triggerRect.height,
      },
      panel: { width: panel.offsetWidth, height: panel.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      align,
      prefer,
    });
    setPosition({ top: next.top, left: next.left, ready: true });
  }, [align, prefer]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition((prev) => (prev.ready ? { ...prev, ready: false } : prev));
      return;
    }
    setPosition((prev) => (prev.ready ? { ...prev, ready: false } : prev));
    measure();
  }, [measure, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeOnResize = () => setOpen(false);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(() => measure());
    if (panelRef.current) observer.observe(panelRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => observer.disconnect();
  }, [measure, open]);

  const toggle = useCallback(() => setOpen((value) => !value), []);

  return {
    triggerRef,
    panelRef,
    open,
    setOpen,
    toggle,
    style: {
      top: position.top,
      left: position.left,
      visibility: position.ready ? "visible" : "hidden",
      position: "fixed",
    },
  };
}

export function Menu({
  trigger,
  items,
  section,
  description,
  align = "start",
  compact = false,
  triggerVariant = "control",
  itemSize = "ui-tight",
  disabled = false,
  disabledReason,
  className,
  ariaLabel = "菜单",
}: MenuProps) {
  const { triggerRef, panelRef, open, setOpen, toggle, style } = useAnchoredLayer({ align });
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      );
      first?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, panelRef]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    triggerRef.current?.focus();
  }, [open, triggerRef]);

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current < 0
        ? event.key === "ArrowDown"
          ? 0
          : options.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % options.length
          : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabledReason ?? ariaLabel}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-control transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1 disabled:cursor-not-allowed disabled:opacity-45",
          triggerVariant === "ghost"
            ? cn(
                "text-ink-2 hover:bg-surface-3 hover:text-ink-1",
                compact ? "h-7 px-2 text-caption" : "h-8 px-2.5 text-ui-tight",
                open && "bg-surface-3 text-ink-1",
              )
            : cn(
                "sc-control border border-control bg-surface-2 text-ink-1 hover:bg-surface-3",
                compact ? "h-7 px-2 text-small" : "h-8 px-3 text-ui",
                open && "bg-surface-3",
              ),
          className,
        )}
      >
        {trigger}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={ariaLabel}
          style={{ ...style, animation: "sc-pop 150ms var(--ease-pop)" }}
          onKeyDown={onPanelKeyDown}
          className={cn(
            // 边界交给 .sc-glass：它按主题给 border（暗色透明）+ 内边缘高光（§1.8）。
            // 在这里再补一层 border-line-* 会把暗色下的高光分界换成一圈实线，正是规范禁止的。
            "sc-glass z-20 max-h-80 overflow-y-auto rounded-card p-1",
            compact ? "w-64" : "w-80",
          )}
        >
          {section && (
            <div className="px-2 py-1.5 text-caption font-medium text-ink-2">{section}</div>
          )}
          {description && <div className="px-2 pb-1 text-caption text-ink-3">{description}</div>}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-checked={item.checked}
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (item.disabled) return;
                item.onSelect?.();
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-start gap-2 rounded-mark px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
                itemSize === "caption" ? "text-caption" : "text-ui-tight",
                item.disabled
                  ? "cursor-not-allowed opacity-45"
                  : item.danger
                    ? "text-danger-1 hover:bg-danger-1/10"
                    : "text-ink-1 hover:bg-surface-3",
                item.checked && !item.disabled && "sc-row-active",
              )}
            >
              {item.icon && <span className="mt-0.5 shrink-0">{item.icon}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.description && (
                  <span className="mt-0.5 block break-words text-caption text-ink-3">
                    {item.description}
                  </span>
                )}
              </span>
              {item.hint && (
                <span className="shrink-0 font-mono text-caption text-ink-3">{item.hint}</span>
              )}
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
              >
                {item.checked && <Check className="size-3.5 text-accent-1" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

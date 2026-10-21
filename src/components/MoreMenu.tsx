import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** 破坏性操作：红字，并且一般要配确认 */
  danger?: boolean;
  disabled?: boolean;
  /** 禁用时的原因：灰着不解释是最烦人的那种禁用 */
  hint?: string;
  onSelect: () => void;
}

/**
 * 通用「⋯」小菜单。
 *
 * 之前 ModeSelect / AgentSelect / ProfilePick 各自写了一份弹层（点外部关闭、Esc 关闭），
 * 这是第四份 —— 抽出来一份，后面加「重命名」「复制 session id」时不用再抄一遍。
 *
 * 触发按钮本身不带样式主张：由调用方决定放哪、多大、何时出现（例如会话条目的 hover）。
 */
export function MoreMenu({
  items,
  label = "更多操作",
  className,
  iconSize = 14,
}: {
  items: MenuItem[];
  label?: string;
  className?: string;
  iconSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={(e) => {
          // 会话条目本身是按钮：不吞掉这一下，会顺带把会话切走
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "grid size-6 place-items-center rounded-[6px] text-ink-3 transition-colors",
          "hover:bg-surface-3/60 hover:text-ink-1",
          open && "bg-surface-3/60 text-ink-1",
        )}
      >
        <MoreHorizontal size={iconSize} />
      </button>

      {open && (
        <div className="sc-glass absolute right-0 top-6 z-30 w-44 rounded-[8px] border border-line-1/60 p-1">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              disabled={it.disabled}
              title={it.disabled ? it.hint : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (it.disabled) return;
                setOpen(false);
                it.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left text-[11px] transition-colors",
                it.disabled
                  ? "cursor-not-allowed text-ink-3/70"
                  : it.danger
                    ? "text-danger-1 hover:bg-danger-1/10"
                    : "text-ink-1 hover:bg-surface-3/45",
              )}
            >
              {it.icon}
              <span className="truncate">{it.label}</span>
            </button>
          ))}
          {items.some((i) => i.disabled && i.hint) && (
            <p className="mt-0.5 border-t border-line-1/40 px-2 pt-1 text-[9px] leading-relaxed text-ink-3">
              {items.find((i) => i.disabled && i.hint)?.hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import type { ModeOption } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface ModeSelectProps {
  /** 当前生效的模式（agent 报的，或我们推成功的） */
  current: string | null;
  /** 可选模式；空数组 = 这个连接没报上来，按钮要显示「不支持」并禁用 */
  available: ModeOption[];
  /** 是否处于「跟随连接默认」（规范 §5.2：这个状态必须能看出来，不能只显示当前值） */
  following: boolean;
  /** 跟随状态下生效的是哪个模式（用来在「跟随」那一行显示副标题） */
  fallbackLabel?: string | null;
  warning?: string | null;
  /** null = 改回跟随连接默认 */
  onChoose: (modeId: string | null) => void;
  disabled?: boolean;
  /** 状态栏用紧凑尺寸，设置页用常规尺寸 */
  compact?: boolean;
}

export function ModeSelect({
  current,
  available,
  following,
  fallbackLabel,
  warning,
  onChoose,
  disabled,
  compact,
}: ModeSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unsupported = available.length === 0;
  const locked = disabled || unsupported;
  const currentLabel =
    (available.find((m) => m.id === current)?.name ?? current) || "未上报";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={locked}
        aria-expanded={open}
        title={unsupported ? "该连接没有报上来可选模式" : (warning ?? undefined)}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex max-w-[220px] items-center gap-1.5 rounded-[6px] transition-colors",
          compact ? "h-7 px-2 text-[11px]" : "h-8 px-2.5 text-[11.5px]",
          locked
            ? "cursor-not-allowed text-ink-3 opacity-60"
            : open
              ? "bg-surface-3/65 text-ink-1"
              : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <span className="truncate">{unsupported ? "不支持" : currentLabel}</span>
        {following && !unsupported && (
          <span className="shrink-0 rounded-[3px] border border-line-1/60 px-1 py-px text-[9px] leading-none text-ink-3">
            跟随
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-ink-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && !unsupported && (
        <div
          className={cn(
            "sc-glass absolute top-full right-0 z-30 mt-1.5 rounded-[10px] p-1",
            compact ? "w-[260px]" : "w-[320px]",
          )}
        >
          <div className="px-2 py-1.5">
            <div className="text-[10.5px] text-ink-2">文件编辑审批</div>
            <div className="mt-0.5 text-[9.5px] leading-relaxed text-ink-3">
              命令执行仍逐条询问；敏感路径永远询问
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              onChoose(null);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors",
              following ? "sc-row-active" : "hover:bg-surface-3/45",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11.5px] text-ink-1">跟随连接默认</span>
              <span className="mt-0.5 block truncate text-[10px] text-ink-3">
                {fallbackLabel ?? "agent 默认"}
              </span>
            </span>
            <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center">
              {following && <Check className="size-3.5 text-accent-1" />}
            </span>
          </button>

          {available.map((m) => {
            const active = m.id === current;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChoose(m.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors",
                  active ? "sc-row-active" : "hover:bg-surface-3/45",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] text-ink-1">{m.name}</span>
                  {m.description && (
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-3">
                      {m.description}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center">
                  {active && <Check className="size-3.5 text-accent-1" />}
                </span>
              </button>
            );
          })}

          {warning && (
            <div className="mt-1 flex items-start gap-1.5 border-t border-line-1/40 px-2 py-2 text-[9.5px] leading-relaxed text-warn-1">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              <span className="min-w-0 break-words">{warning}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

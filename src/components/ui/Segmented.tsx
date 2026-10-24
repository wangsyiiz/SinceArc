import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Segmented<T extends string>(props: {
  options: { value: T; label: string; icon?: ReactNode; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  compact?: boolean;
  ariaLabel?: string;
}) {
  const { options, value, onChange, disabled = false, compact = false, ariaLabel } = props;
  if (options.length === 0) return null;

  const count = options.length;
  const active = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const trackRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 滑块按「当前选项的真实位置」画，不用等分推算 */
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  /**
   * 选项宽度不等（「深色」「跟随系统」差一个字），所以滑块的位置与宽度必须量出来。
   * 曾经用 `calc((100% - n*4px)/n)` 等分：三段标签长短不一时滑块只有 52px，
   * 却压在 72px 的选项上，左缘直接盖住相邻选项的文字（实测对齐误差 20px）。
   */
  useLayoutEffect(() => {
    const measure = () => {
      const el = itemRefs.current[active];
      const track = trackRef.current;
      if (!el || !track) return;
      const t = track.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // 选项框内留 2px 净空，与轨道上下 2px 一致，不然滑块贴着分隔缝像被裁过
      setThumb({ left: r.left - t.left + 2, width: Math.max(0, r.width - 4) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);
    for (const item of itemRefs.current) if (item) observer.observe(item);
    return () => observer.disconnect();
  }, [active, count, options.length]);

  const move = (direction: -1 | 1) => {
    if (disabled) return;
    for (let step = 1; step <= count; step += 1) {
      const next = (active + direction * step + count) % count;
      const option = options[next];
      if (!option?.disabled) {
        onChange(option.value);
        return;
      }
    }
  };

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn("sc-switch shrink-0", disabled && "opacity-50")}
      style={{ height: compact ? 28 : 32 }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        }
      }}
    >
      <span
        aria-hidden="true"
        className="sc-switch__thumb"
        style={
          thumb
            ? {
                // 量到之前先不画：否则会先出现在 0 位再跳过去
                left: 0,
                width: thumb.width,
                transform: `translateX(${thumb.left}px)`,
              }
            : { width: 0, opacity: 0 }
        }
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          type="button"
          disabled={disabled || option.disabled}
          title={option.title}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "sc-switch__item focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
            "whitespace-nowrap",
            compact ? "px-2 text-small" : "px-3 text-ui",
            option.disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {option.icon && (
            <span className="sc-switch__icon" aria-hidden="true">
              {option.icon}
            </span>
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}

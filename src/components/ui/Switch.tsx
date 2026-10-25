import { cn } from "@/lib/utils";

/**
 * 开关。轨道永远是平的（surface-3 + 控件边界），**不整片点亮** ——
 * 暗色主题的 accent 是浅灰（近白），拿它填整条轨道会变成一块白板，
 * 和「底层平铺 + 圆角边框」的语言冲突。开/关的差别只由两处表达：
 * 圆点在左还是在右，以及圆点是暗灰还是亮白。
 *
 * 圆点必须写死 left/top（`left-px top-px`）：只写 `absolute` 时，
 * 按钮默认 `text-align: center` 会把无定位的绝对子元素摆在居中位置，
 * 于是 off 也贴右、on 直接溢出到控件外面（实测 off=18px、on=32px，右缘越界 12px）。
 */
export function Switch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-4 w-8 shrink-0 rounded-control border border-control bg-surface-3 transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-px top-px size-3 rounded-mark transition-transform",
          checked ? "translate-x-4 bg-ink-1" : "translate-x-0 bg-ink-3",
        )}
      />
    </button>
  );
}

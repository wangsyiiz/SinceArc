import { cn } from "@/lib/utils";

export function Segmented<T extends string>(props: {
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
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
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn("sc-switch", disabled && "opacity-50")}
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
        style={{
          width: `calc((100% - ${count * 4}px) / ${count})`,
          transform: `translateX(calc(${active * 100}% + ${active * 4}px))`,
        }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled || option.disabled}
          title={option.title}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "sc-switch__item focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
            compact ? "px-2 text-small" : "px-3 text-ui",
            option.disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

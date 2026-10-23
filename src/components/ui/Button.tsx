import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonStyles = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1 disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-accent-1 text-accent-ink hover:brightness-110 active:brightness-95",
        secondary:
          "sc-control border border-control bg-surface-2 text-ink-1 hover:bg-surface-3 active:bg-surface-2",
        ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink-1 active:bg-surface-3",
        /* 玻璃按钮：底色/模糊/边界交给 .sc-glass，再叠一层 --glass-control 洗色 ——
           纯玻璃叠在玻璃上实测只差 2~3 个色阶（按钮面与输入框面几乎同色），等于看不见。 */
        glass: "sc-glass bg-glass-control text-ink-1 hover:bg-surface-3/50 active:bg-surface-3/70",
      },
      size: {
        sm: "h-7 px-2.5 text-small",
        md: "h-9 px-3 text-ui",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "glass";
    size?: "sm" | "md";
    danger?: boolean;
    loading?: boolean;
    disabledReason?: string;
    reasonText?: string;
  }
> = ({
  variant = "secondary",
  size = "md",
  danger = false,
  loading = false,
  disabledReason,
  reasonText,
  className,
  children,
  title,
  type,
  ...props
}) => {
  const button = (
    <button
      {...props}
      type={type ?? "button"}
      title={title ?? disabledReason}
      aria-busy={loading || undefined}
      className={cn(buttonStyles({ variant, size }), danger && "text-danger-1", className)}
    >
      <span className={cn("inline-flex items-center gap-2", loading && "opacity-0")}>
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center" aria-live="polite">
          加载中…
        </span>
      )}
    </button>
  );

  if (!reasonText) return button;
  return (
    <span className="inline-flex flex-col gap-1">
      {button}
      <span className="text-caption text-ink-3">{reasonText}</span>
    </span>
  );
};

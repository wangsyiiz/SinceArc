import { Layers } from "lucide-react";

const R = 7;
const CIRC = 2 * Math.PI * R;

/**
 * 上下文用量环（docs/desktop-ux.md §24）：18px 的环 + 中央的上下文图标。
 *
 * `percent` 由后端算好（`UsageDto.percent`，0–100），这里只换算弧长，不做第二次除法 ——
 * 前端重算比例就会出现「环和文案对不上」的那种错。
 */
export function UsageRing({ percent, warn }: { percent: number; warn: boolean }) {
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  return (
    <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
      <svg viewBox="0 0 18 18" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          strokeWidth="1.5"
          style={{ stroke: "var(--l1)", opacity: 0.4 }}
        />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - ratio)}
          style={{ stroke: warn ? "var(--warn)" : "var(--a1)" }}
        />
      </svg>
      <Layers className="size-2.5 text-ink-3" aria-hidden="true" />
    </span>
  );
}

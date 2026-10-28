import type { TFunction } from "i18next";
import { currentLocale } from "../i18n/locale.ts";

/** 18530 → "18.5k"；1000000 → "1M"；999 → "999" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${trimDecimal(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimDecimal(n / 1_000)}k`;
  return String(Math.round(n));
}

function trimDecimal(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** 上下文一行文案：是否进入告警档也在这里判，界面只读结果。 */
export function describeUsage(u: { used: number; size: number; percent: number }, t: TFunction): {
  text: string;
  warn: boolean;
} {
  const warn = u.percent >= 80;
  const text = t(warn ? "usage.line.warn" : "usage.line.normal", {
    used: formatTokens(u.used),
    size: formatTokens(u.size),
    percent: new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 0 }).format(u.percent),
  });
  return {
    text,
    warn,
  };
}

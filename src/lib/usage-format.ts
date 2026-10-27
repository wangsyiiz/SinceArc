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
export function describeUsage(u: { used: number; size: number; percent: number }): {
  text: string;
  warn: boolean;
} {
  const warn = u.percent >= 80;
  const base = `上下文 ${formatTokens(u.used)} / ${formatTokens(u.size)}（${u.percent}%）`; // i18n-ignore: 唯一消费点 App.tsx 不在本批次白名单
  return {
    text: warn ? `${base}，再问下去 agent 可能会丢开头` : base, // i18n-ignore: 唯一消费点 App.tsx 不在本批次白名单
    warn,
  };
}

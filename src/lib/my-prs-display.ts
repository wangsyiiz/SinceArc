/** 标题栏角标与 hover 面板的纯展示逻辑（docs/desktop-ux.md §48）。 */

/** 0 / 不可用不渲染角标；1..99 原数；满 100 或 hasMore 显示 99+。 */
export function badgeLabel(count: number, hasMore: boolean): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (hasMore || count > 99) return "99+";
  return String(Math.floor(count));
}

/** 面板最多显示前 `limit` 条，其余去 GitHub 看。 */
export function topItems<T>(items: readonly T[], limit = 8): T[] {
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return items.slice(0, size);
}

/** ISO 时间 → 本地 `hh:mm`；解析失败原样返回。 */
export function clockTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

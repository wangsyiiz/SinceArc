/** 标题栏角标与菜单的纯展示逻辑（docs/desktop-ux.md §48）。 */

import type { MyPrDto } from "./ipc/types.gen/MyPrDto.ts";
import { relativeTime } from "./relative-time.ts";

/** 0 / 不可用不渲染角标；1..99 原数；满 100 或 hasMore 显示 99+。 */
export function badgeLabel(count: number, hasMore: boolean): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (hasMore || count > 99) return "99+";
  return String(Math.floor(count));
}

/** 菜单最多显示前 `limit` 条，其余去 GitHub 看。 */
export function topItems<T>(items: readonly T[], limit = 8): T[] {
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return items.slice(0, size);
}

export interface PrMenuRow {
  id: string;
  label: string;
  hint: string;
  description: string;
  url: string;
}

/** PR 行 → 菜单项字段；文案（草稿）与 locale 由调用方传入，便于单测。 */
export function prMenuRows(
  items: readonly MyPrDto[],
  opts: { draftLabel: string; locale: string; limit?: number },
): PrMenuRow[] {
  return topItems(items, opts.limit ?? 8).map((pr) => ({
    id: `${pr.repo}#${pr.number}`,
    label: pr.title,
    hint: `#${pr.number}`,
    description: `${pr.isDraft ? `${opts.draftLabel} · ` : ""}${pr.repo} · ${relativeTime(
      pr.updatedAt,
      opts.locale,
    )}`,
    url: pr.url,
  }));
}

/** ISO 时间 → 本地 `hh:mm`；解析失败原样返回。 */
export function clockTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * ISO8601 → `YYYY-MM-DD HH:mm`（机器本地时区）。
 *
 * PR 的 `updatedAt` / `createdAt` 来自 gh，是 UTC 的 ISO 串；直接显示原文
 * 既长又难读。不引时间库：只做一次 `Date` 解析 + 两位补零，解析失败原样返回。
 * 刻意不依赖 `i18n/locale`，这样 `node --test` 可以直接跑。
 */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

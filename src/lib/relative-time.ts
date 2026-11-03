/**
 * ISO 时间 → 相对时间（由 `Intl.RelativeTimeFormat` 给出本地化文案，不写死中文）。
 * 解析失败原样返回；空串也原样返回，让「缺发布时间」的条目由调用方决定占位。
 */
export function relativeTime(value: string, locale: string, nowMs = Date.now()): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;

  const diff = time - nowMs;
  const abs = Math.abs(diff);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return formatter.format(Math.round(diff / size), unit);
  }
  return formatter.format(Math.round(diff / 1000), "second");
}

/** 文件大小：只用于远程文件树；目录的 `size` 可能为空。 */
export function formatBytes(size: number | null | undefined): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

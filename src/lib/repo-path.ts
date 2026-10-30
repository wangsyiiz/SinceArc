/**
 * 本地仓库路径归一：前后空白、Windows 反斜杠、尾部分隔符。
 * 盘符根保留成 `C:/`（不能把 `C:\` 变成 `C:`）。
 */
export function normalizeRepoPath(input: string): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) return "";
  const drive = /^[A-Za-z]:/.exec(raw)?.[0];
  if (drive && /^[A-Za-z]:\/*$/.test(raw)) {
    return `${drive}/`;
  }
  let end = raw.length;
  while (end > 1 && raw[end - 1] === "/") end -= 1;
  return raw.slice(0, end);
}

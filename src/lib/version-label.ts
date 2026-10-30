/**
 * 版本号的展示口径（§35）。
 *
 * 只做两件事：把 `getVersion()` 的裸版本串变成界面上的标签，以及判断要不要挂 beta 角标。
 * 判断规则写在这里而不是 JSX 里，是为了能单独测：0.x 一律算 beta，1.0.0 起自动消失。
 */

/** `0.0.8` → `true`；`1.0.0` → `false`；解析不出来 → `false`（宁可不显示角标）。 */
export function isBetaVersion(version: string | null | undefined): boolean {
  if (typeof version !== "string") return false;
  const major = version.trim().split(".")[0];
  if (!/^\d+$/.test(major)) return false;
  return Number(major) === 0;
}

/** 界面上的版本标签：`0.0.8` → `v0.0.8`；空值 → `null`（调用方据此不渲染）。 */
export function versionLabel(version: string | null | undefined): string | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

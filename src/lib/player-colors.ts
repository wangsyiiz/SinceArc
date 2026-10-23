/**
 * 成员标识色板 —— **不属于设计令牌体系**。
 *
 * 这 6 个颜色不是 UI 配色，是数据：用户靠色相分辨「这条发言是谁说的」。
 * 所以：
 * - 不进 `styles.css` 的 `:root`，不许被"统一风格"换成语义色（ok/warn/danger）
 *   或面阶灰 —— 那样「红」会同时表示错误和某个人的头像色，而且两个灰会让人分不清；
 * - 由 `style-guard` 的 color-literal 规则按文件豁免（见 `style-guard.allowlist.ts`
 *   的 `COLOR_LITERAL_EXEMPT`），其它任何文件照旧一个色值都不许写；
 * - 用户自己选的颜色另存于 profile（`AgentUser.color`），这里只是**可选清单**。
 *
 * 改色相会改变已保存成员的外观识别度 —— 要改先问所有者。
 */
export const PLAYER_COLORS = [
  "#8ab4f8",
  "#f2b8b5",
  "#a8d8a8",
  "#ffd580",
  "#c9a8f2",
  "#8fd8d2",
] as const;

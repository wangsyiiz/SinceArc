/**
 * 棘轮清单：P1 之前就存在的违规。
 * 只许减少 —— 修掉一条就从这里删一行（数字必须来自真实扫描，2026-10-23 修正了十进制 px 漏数）；新增违规会让测试红。
 * 每条注明归属（哪个组件、为什么暂时留着），P2 逐个清。
 */
/**
 * 按文件豁免某条规则。
 *
 * `color-literal` 只豁免 `lib/player-colors.ts`（成员标识色板，属于数据而不是 UI 配色）
 * 与 `lib/highlight/themes.ts`（代码主题色表；§20 明确允许色值只出现在这里与代码 CSS）。
 * （agent 品牌标记只保留形状、不含色值，所以不再需要豁免。）
 * 豁免必须按文件枚举，不许按目录、不许按"包含 color 字样"这类宽判据 ——
 * 那等于把色值禁令废掉。
 */
export const COLOR_LITERAL_EXEMPT: string[] = [
  "lib/player-colors.ts",
  "lib/highlight/themes.ts",
];

export const ALLOWED: Record<string, { rule: string; count: number; why: string }[]> = {};

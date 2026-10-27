/**
 * 中文文案：**唯一事实源**（docs/i18n.md §1）。
 *
 * key 用扁平点分名 + `keySeparator: false`：这样 `keyof typeof zhCN` 就是全量 key 的联合类型，
 * `t()` 拼错 key 直接编译报错；`en.ts` 声明成 `Record<MessageKey, string>`，少一条也编译报错。
 */
export const zhCN = {
  "language.label": "语言",
  "language.zh": "中文",
  "language.en": "English",
} as const;

/** 全量文案 key。新增文案只加在这里，再补 `en.ts`。 */
export type MessageKey = keyof typeof zhCN;

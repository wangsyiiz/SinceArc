/** 支持的语言。加第三种语言时只改这里 + 加一份资源（docs/i18n.md §0）。 */
export type Language = "zh-CN" | "en";

export const LANGUAGES: readonly Language[] = ["zh-CN", "en"];

/** 兜底语言：归一化判定之外的一切输入都落到这里（docs/i18n.md §2.2）。 */
export const DEFAULT_LANGUAGE: Language = "en";

/**
 * 语言标签归一化 —— **同一判据只写这一处**（docs/i18n.md §2.2）。
 *
 * - `zh` 开头（zh、zh-CN、zh-TW、zh-Hans…）→ `zh-CN`（本轮只有一份中文，不做繁体）
 * - `en` 开头（en、en-US、en-GB…）→ `en`
 * - 其余一切（空串、null、非字符串、fr-FR、乱码）→ `en`（默认动作：不报错、不空界面）
 */
export function normalizeLanguage(input: unknown): Language {
  if (typeof input !== "string") return DEFAULT_LANGUAGE;
  const tag = input.trim().toLowerCase();
  const primary = tag.split(/[-_]/)[0];
  if (primary === "zh") return "zh-CN";
  if (primary === "en") return "en";
  return DEFAULT_LANGUAGE;
}

/** 是否是我们真的支持的值（用来判断"库里存的是不是脏值"）。 */
export function isSupportedLanguage(input: unknown): input is Language {
  return typeof input === "string" && (LANGUAGES as readonly string[]).includes(input);
}

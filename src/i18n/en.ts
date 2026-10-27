import type { MessageKey } from "./zh-CN";

/**
 * 英文文案。类型是 `Record<MessageKey, string>`：少一条、key 拼错、写了个中文表里没有的 key，
 * 全部编译报错 —— 一致性由类型保证，再由 `resources.test.ts` 兜一层运行时校验（占位符、空串）。
 */
export const en: Record<MessageKey, string> = {
  "language.label": "Language",
  "language.zh": "Chinese",
  "language.en": "English",
};

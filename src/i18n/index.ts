import type { Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en.ts";
import { i18n } from "./instance.ts";
import { normalizeLanguage, type Language } from "./normalize.ts";
import { zhCN } from "./zh-CN.ts";

/** 资源只在这里组装一次；语言表由 `zh-CN.ts` 决定（docs/i18n.md §1）。 */
// i18next 的 resources 形状是 `{ [语言]: { [命名空间]: 资源 } }` —— **语言在前**。
// 写成 `{ app: { "zh-CN": … } }` 会让 i18next 认为语言叫 "app"、命名空间叫 "zh-CN"，
// 结果每个 key 都查不到，界面上整片显示 key 原文（不报错，只在 console 里 warn）。
const resources: Resource = { "zh-CN": { app: zhCN }, en: { app: en } };

export { i18n } from "./instance.ts";

/**
 * 初始化（幂等）。语言来源是 `settings.language` 或首启判定的系统语言，都先过归一化。
 *
 * 缺 key 的两级兜底：先把 `fallbackLng` 的英文取出来；英文也没有，则原样显示 key 并告警 ——
 * 不显示空白、不显示"未知文案"，否则漏译在界面上看不出来（docs/i18n.md §1）。
 */
export function initI18n(language: unknown): Language {
  const lng = normalizeLanguage(language);
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources,
      lng,
      fallbackLng: "en",
      defaultNS: "app",
      ns: ["app"],
      keySeparator: false,
      nsSeparator: false,
      returnNull: false,
      initAsync: false,
      interpolation: { escapeValue: false },
      parseMissingKeyHandler: (key) => {
        console.warn("[i18n] 缺少文案 key:", key);
        return key;
      },
    });
  } else if (i18n.language !== lng) {
    void i18n.changeLanguage(lng);
  }
  if (typeof document !== "undefined") document.documentElement.lang = lng;
  return lng;
}

export { normalizeLanguage };
export type { Language };

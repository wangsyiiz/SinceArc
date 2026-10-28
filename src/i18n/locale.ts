import { i18n } from "./instance.ts";
import { normalizeLanguage, type Language } from "./normalize.ts";

/** 当前界面 locale；每次调用时读取，切语言后无需重新加载模块。 */
export function currentLocale(): Language {
  return normalizeLanguage(i18n.language);
}

import i18next, { type i18n as I18n } from "i18next";

/** 纯 i18next 实例：不依赖 React，供格式化等非组件模块读取当前语言。 */
export const i18n: I18n = i18next.createInstance();

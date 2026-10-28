import type { TFunction } from "i18next";
import type { MessageKey } from "@/i18n/zh-CN";

export type I18nTextParams = Record<string, string | number>;

export interface DecodedI18nText {
  key: MessageKey;
  params: I18nTextParams;
}

const MARKER = "\u001eI18N:";
const SEP = "\u001f";

/** 在只能传字符串的数据通道里携带「文案 key + 参数」，由渲染层再翻译。 */
export function i18nText(key: MessageKey, params: I18nTextParams = {}): string {
  return `${MARKER}${key}${SEP}${JSON.stringify(params)}`;
}

export function decodeI18nText(text: string): DecodedI18nText | null {
  if (!text.startsWith(MARKER)) return null;
  const split = text.indexOf(SEP, MARKER.length);
  if (split < 0) return null;
  try {
    return {
      key: text.slice(MARKER.length, split) as MessageKey,
      params: JSON.parse(text.slice(split + 1)) as I18nTextParams,
    };
  } catch {
    return null;
  }
}

type LooseTranslate = (key: string, params?: I18nTextParams) => string;

/**
 * 动态 key + 动态参数走这里。
 *
 * i18next 的严格类型要求「每个 key 的参数集合是固定的」，而我们的 key 来自数据
 * （`TraceText`、preset 的 `originKey`、marker 解码结果），编译期无法收窄到某一个 key，
 * 于是只能在这里做一次显式收窄。这是唯一允许绕过严格类型的地方。
 */
export function translateKey(
  t: TFunction | LooseTranslate,
  key: MessageKey,
  params?: I18nTextParams,
): string {
  const loose = t as unknown as LooseTranslate;
  // 没有参数时不要传 `undefined` 进去：i18next 会把显式 undefined 当成"有第二个实参"，
  // 测试里断言的实参形状也会跟着漂。
  return params ? loose(key, params) : loose(key);
}

/** 只为内部带 key 的字符串做翻译；普通用户/agent 文本原样返回。 */
export function localizeText(text: string, t: TFunction): string {
  const decoded = decodeI18nText(text);
  if (!decoded) return text;
  const params = Object.fromEntries(
    Object.entries(decoded.params).map(([key, value]) => [
      key,
      typeof value === "string" ? localizeText(value, t) : value,
    ]),
  );
  return translateKey(t, decoded.key, params);
}

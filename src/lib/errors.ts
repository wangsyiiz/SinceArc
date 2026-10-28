import type { TFunction } from "i18next";
import type { MessageKey } from "@/i18n/zh-CN";
import { translateKey } from "./i18n-text.ts";

export const CODE_KEYS: Record<number, MessageKey> = {
  50102: "error.50102",
  50201: "error.50201",
  50202: "error.50202",
  50403: "error.50403",
  50500: "error.50500",
  50501: "error.50501",
  50702: "error.50702",
  50703: "error.50703",
  50704: "error.50704",
};

/** 命中 9 个 1:1 的码就翻译；其余（含未来的码）原样返回 msg，不吞错。 */
export function errorText(code: number, msg: string, t: TFunction): string {
  if (typeof code !== "number") return msg;
  const key = CODE_KEYS[code];
  if (!key) return msg;
  return translateKey(t, key);
}

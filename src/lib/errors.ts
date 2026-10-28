import type { TFunction } from "i18next";
import type { MessageKey } from "@/i18n/zh-CN";
import { zhCN } from "../i18n/zh-CN.ts";
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

/**
 * 错误条的唯一入口：优先用 Rust 报上来的文案 key，其次查历史 code 表，最后原样显示 msg。
 *
 * `err.key` 是运行时字符串，不能直接交给 `t()` —— 资源里没有的 key 会被 i18next 原样回显，
 * 用户看到的就是 `err.foo.bar`。所以先确认 key 确实存在于中文资源表，再显式收窄类型。
 */
export function errorTextOf(
  err: { code: number; msg: string; key?: string; params?: Record<string, string> },
  t: TFunction,
): string {
  if (err.key && Object.prototype.hasOwnProperty.call(zhCN, err.key)) {
    return translateKey(t, err.key as MessageKey, err.params);
  }
  return errorText(err.code, err.msg, t);
}

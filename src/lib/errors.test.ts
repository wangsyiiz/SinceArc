import assert from "node:assert/strict";
import test from "node:test";
import type { TFunction } from "i18next";
import { zhCN } from "../i18n/zh-CN.ts";
import { CODE_KEYS, errorText } from "./errors.ts";

test("已映射的码按当前语言翻译，t 收到对应 key", () => {
  let language: "zh-CN" | "en" = "en";
  const seen: string[] = [];
  const t = ((key: string) => {
    seen.push(key);
    return `${language}:${key}`;
  }) as unknown as TFunction;

  assert.equal(errorText(50702, "子任务不能再派活（深度上限 1）", t), "en:error.50702");
  language = "zh-CN";
  assert.equal(errorText(50702, "子任务不能再派活（深度上限 1）", t), "zh-CN:error.50702");
  assert.deepEqual(seen, ["error.50702", "error.50702"]);
});

test("未登记的码原样返回 msg", () => {
  const t = (() => {
    throw new Error("未登记的码不应调用 t");
  }) as unknown as TFunction;
  assert.equal(errorText(50000, "原始错误", t), "原始错误");
});

test("空 msg + 未登记码返回空串，不抛", () => {
  const t = (() => {
    throw new Error("空 msg 不应调用 t");
  }) as unknown as TFunction;
  assert.equal(errorText(50000, "", t), "");
});

test("空 msg + 已登记码仍然翻译（那 9 条文案不依赖 msg）", () => {
  const t = ((key: string) => `T:${key}`) as unknown as TFunction;
  assert.equal(errorText(50102, "", t), "T:error.50102");
});

test("CODE_KEYS 里的每个 key 都存在于 zh-CN.ts", () => {
  for (const [code, key] of Object.entries(CODE_KEYS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(zhCN, key),
      `error.${code} 映射到了不存在的 key: ${key}`,
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { TFunction } from "i18next";
import { zhCN } from "../i18n/zh-CN.ts";
import { CODE_KEYS, errorText, errorTextOf } from "./errors.ts";

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

test("errorTextOf：err.key 命中资源时，t 收到 key 与 params", () => {
  const calls: unknown[][] = [];
  const t = ((...args: unknown[]) => {
    calls.push(args);
    return "translated";
  }) as unknown as TFunction;
  const params = { member: "alice", detail: "42" };

  assert.equal(
    errorTextOf(
      { code: 50704, msg: "delegate 句柄不存在", key: "err.delegate.handleMissing", params },
      t,
    ),
    "translated",
  );
  assert.deepEqual(calls, [["err.delegate.handleMissing", params]]);
});

test("errorTextOf：err.key 不存在时回落到 code 表", () => {
  const calls: unknown[][] = [];
  const t = ((...args: unknown[]) => {
    calls.push(args);
    return "from-code-table";
  }) as unknown as TFunction;

  assert.equal(
    errorTextOf(
      { code: 50702, msg: "子任务不能再派活（深度上限 1）", key: "err.not.a.real.key" },
      t,
    ),
    "from-code-table",
  );
  assert.deepEqual(calls, [["error.50702"]]);
});

test("errorTextOf：err.key 不存在且 code 未登记时原样返回 msg", () => {
  const t = (() => {
    throw new Error("未命中的 key/code 不应调用 t");
  }) as unknown as TFunction;

  assert.equal(
    errorTextOf({ code: 50000, msg: "原始错误", key: "err.not.a.real.key" }, t),
    "原始错误",
  );
});

test("errorTextOf：params 为 undefined 时不传第二个实参", () => {
  const calls: unknown[][] = [];
  const t = ((...args: unknown[]) => {
    calls.push(args);
    return "translated";
  }) as unknown as TFunction;

  assert.equal(
    errorTextOf({ code: 50500, msg: "这个请求已失效或已被回答", key: "err.permission.stale" }, t),
    "translated",
  );
  // translateKey 在没有参数时只传 key：显式传 undefined 会让 i18next 多拿一个实参，
  // 也会让断言形状随实现细节漂。
  assert.deepEqual(calls, [["err.permission.stale"]]);
});

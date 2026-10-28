import assert from "node:assert/strict";
import test from "node:test";
import { en } from "./en.ts";
import { zhCN } from "./zh-CN.ts";

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();

test("两种语言的 key 集合完全相等", () => {
  const zh = Object.keys(zhCN).sort();
  const other = Object.keys(en).sort();
  assert.deepEqual(other, zh);
});

test("同一 key 的占位符集合相等（漏一个参数就是拼错的文案）", () => {
  for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
    assert.deepEqual(placeholders(en[key]), placeholders(zhCN[key]), `占位符不一致: ${key}`);
  }
});

test("同一 key 的内联标签集合相等（<Trans> 用的标签，两边得一致）", () => {
  const tags = (value: string): string[] =>
    [...value.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[ >/]/g)].map((m) => m[1].toLowerCase()).sort();
  for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
    assert.deepEqual(tags(en[key]), tags(zhCN[key]), `内联标签不一致: ${key}`);
  }
});

test("没有空文案", () => {
  for (const [key, value] of Object.entries(zhCN)) assert.ok(value.trim(), `中文空文案: ${key}`);
  for (const [key, value] of Object.entries(en)) assert.ok(value.trim(), `英文空文案: ${key}`);
});

test("key 不含空白、首尾不以点开头", () => {
  for (const key of Object.keys(zhCN)) {
    assert.ok(!/\s/.test(key), `key 含空白: ${key}`);
    assert.ok(!key.startsWith(".") && !key.endsWith("."), `key 有点号边界问题: ${key}`);
  }
});

/**
 * 回归：`resources` 的形状必须是 `{ [语言]: { [命名空间]: 资源 } }`。
 *
 * 曾经写成 `{ app: { "zh-CN": zhCN, en } }`（语言与命名空间颠倒）：i18next 认为语言叫 "app"，
 * 于是每个 key 都查不到，界面整片显示 key 原文 —— 不报错、不抛异常，只在 console 里 warn，
 * 前面几条一致性测试（key 集合/占位符/空串）全都拦不住。所以这里真的实例化一次再取文案。
 */
test("initI18n 之后 t() 能取到真实文案（资源形状正确）", async () => {
  const { i18n, initI18n } = await import("./index.ts");
  initI18n("zh-CN");
  assert.equal(i18n.t("sidebar.nav.sessions"), "会话");
  initI18n("en");
  assert.equal(i18n.t("sidebar.nav.sessions"), "Sessions");
  // 未知 key 走两级兜底：原样显示 key（不显示空白）
  assert.equal(i18n.t("nope.does.not.exist"), "nope.does.not.exist");
});


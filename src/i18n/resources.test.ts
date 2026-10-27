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

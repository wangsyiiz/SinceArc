/**
 * id 生成器的回归测试。
 *
 * 事故背景：以前用 `u-${Date.now()}`，同一毫秒连发两条会拿到同一个 id，
 * 落库是 `ON CONFLICT(id) DO UPDATE` —— 后一条把前一条覆盖，历史少一条。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { newId } from "./ids.ts";

test("同一毫秒内连续生成也不重复", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 5000; i += 1) ids.add(newId("u"));
  assert.equal(ids.size, 5000);
});

test("带前缀，便于在库里认来源", () => {
  assert.match(newId("sys"), /^sys-/);
  assert.match(newId(""), /^-/);
});

test("长度可控（不会随时间推移无限变长）", () => {
  const id = newId("u");
  assert.ok(id.length < 32, `id 太长：${id}`);
});

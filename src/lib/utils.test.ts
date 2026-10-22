/**
 * cn() 的冲突判定：自定义字号档必须和文字颜色分属两组。
 *
 * 真实事故（P2a 之后，所有者看图指出「下拉框点击时字体又变大一级」）：
 * tailwind-merge 默认不认 `text-caption` 这类自定义字号，把它当颜色，
 * 于是 `cn("text-caption", "text-ink-1")` 只留下 `text-ink-1`，字号掉回继承值。
 * Menu 的 open 分支正是「补一个 text-ink-1」，所以只有打开的那一瞬间变大。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cn } from "./utils.ts";

const has = (out: string, token: string) => out.split(/\s+/).includes(token);

test("字号与颜色互不顶掉", () => {
  const out = cn("text-caption", "text-ink-1");
  assert.ok(has(out, "text-caption"), `字号被顶掉了：${out}`);
  assert.ok(has(out, "text-ink-1"), `颜色丢了：${out}`);

  const tight = cn("text-ui-tight", "text-danger-1");
  assert.ok(has(tight, "text-ui-tight"), `字号被顶掉了：${tight}`);
  assert.ok(has(tight, "text-danger-1"), `颜色丢了：${tight}`);
});

test("同一组内仍然按后者覆盖", () => {
  const size = cn("text-caption", "text-ui-tight");
  assert.ok(has(size, "text-ui-tight"));
  assert.ok(!has(size, "text-caption"), `同组未被覆盖：${size}`);

  const color = cn("text-ink-1", "text-ink-2");
  assert.ok(has(color, "text-ink-2"));
  assert.ok(!has(color, "text-ink-1"), `同组未被覆盖：${color}`);
});

test("带变体的颜色不影响基础字号", () => {
  const out = cn("text-caption", "hover:text-ink-1");
  assert.ok(has(out, "text-caption"));
  assert.ok(has(out, "hover:text-ink-1"));
});

test("micro 档同样受保护（P2b 新增的最小档）", () => {
  const out = cn("text-micro", "text-ink-3");
  assert.ok(has(out, "text-micro"), `最小档被颜色顶掉了：${out}`);
  assert.ok(has(out, "text-ink-3"));
});

/**
 * 会话计时读数（docs/desktop-ux.md §25.3 / §25.4 第 4 条）。
 *
 * 只测格式这条纯规则：< 1h 走 m:ss，≥ 1h 走 h:mm:ss。计时起点由组件在 sessionId 变化时重置，
 * 那部分属于组件行为，不在这里断言。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { clockHHMM, formatElapsed } from "./session-elapsed.ts";

test("不足一小时用 m:ss，秒补零", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7_000), "0:07");
  assert.equal(formatElapsed(67_000), "1:07");
  assert.equal(formatElapsed(3_599_000), "59:59");
});

test("满一小时进位到 h:mm:ss", () => {
  assert.equal(formatElapsed(3_600_000), "1:00:00");
  assert.equal(formatElapsed(3_600_000 + 61_000), "1:01:01");
  assert.equal(formatElapsed(2 * 3_600_000 + 5 * 60_000), "2:05:00");
});

test("秒位向下取整，负数夹到 0（时钟回拨时不出现 -1:-1）", () => {
  assert.equal(formatElapsed(999), "0:00");
  assert.equal(formatElapsed(-5_000), "0:00");
});

test("开始时刻是本地 HH:MM，两位补零", () => {
  const stamp = new Date(2026, 9, 29, 9, 5, 0).getTime();
  assert.equal(clockHHMM(stamp), "09:05");
  const late = new Date(2026, 9, 29, 23, 59, 0).getTime();
  assert.equal(clockHHMM(late), "23:59");
});

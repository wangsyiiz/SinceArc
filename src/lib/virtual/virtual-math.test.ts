import assert from "node:assert/strict";
import test from "node:test";
import {
  isTailChange,
  anchorTargetScrollTop,
  isAtBottom,
  shouldFollowBottom,
} from "./virtual-math.ts";

test("锚点恢复：上方插入后把行拉回原偏移", () => {
  // 原 offset 100，插入 200px 历史后变成 300，scrollTop 需补 200。
  assert.equal(anchorTargetScrollTop(500, 300, 100), 700);
});

test("锚点恢复：上方变高/变矮都按位移补偿", () => {
  assert.equal(anchorTargetScrollTop(500, 320, 100), 720);
  assert.equal(anchorTargetScrollTop(500, 40, 100), 440);
});

test("atBottom 阈值 8px 的 7/8/9 边界", () => {
  const metrics = (gap: number) => ({ scrollHeight: 1000, scrollTop: 600 - gap, clientHeight: 400 });
  assert.equal(isAtBottom(metrics(7)), true);
  assert.equal(isAtBottom(metrics(8)), true);
  assert.equal(isAtBottom(metrics(9)), false);
});

test("贴底策略：上翻后不跟随", () => {
  assert.equal(shouldFollowBottom(true, true), true);
  assert.equal(shouldFollowBottom(true, false), false);
  assert.equal(shouldFollowBottom(false, true), false);
});

test("前插不算尾部变化：只有最后一条换了才跟随", () => {
  // 加载更早：尾部没变 → 不许触发贴底跟随
  assert.equal(isTailChange("seed-999-2", "seed-999-2"), false);
  // 新消息到达：尾部换了 → 跟随
  assert.equal(isTailChange("seed-999-2", "seed-1000-2"), true);
  // 空列表到有内容
  assert.equal(isTailChange(null, "seed-0-1"), true);
  // 清空
  assert.equal(isTailChange("seed-0-1", null), false);
});

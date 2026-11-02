import assert from "node:assert/strict";
import test from "node:test";
import { fitTabs } from "./tab-fit.ts";

const base = { minW: 120, maxW: 200, gap: 1, pinned: [] as string[], activeId: null as string | null };

test("宽度足够时全部可见，overflow 为空", () => {
  const out = fitTabs({ ...base, width: 500, tabs: ["a", "b", "c"] });
  assert.deepEqual(out.visible, ["a", "b", "c"]);
  assert.deepEqual(out.overflow, []);
});

test("正好放下 n 个时第 n 个可见，少 1px 时最后一个进 overflow", () => {
  const tabs = ["a", "b", "c", "d"];
  const exact = fitTabs({ ...base, width: 3 * 120 + 2 * 1, tabs });
  assert.deepEqual(exact.visible, ["a", "b", "c"]);
  assert.deepEqual(exact.overflow, ["d"]);

  const short = fitTabs({ ...base, width: 3 * 120 + 2 * 1 - 1, tabs });
  assert.deepEqual(short.visible, ["a", "b"]);
  assert.deepEqual(short.overflow, ["c", "d"]);
});

test("active 在末尾时仍然可见，前面的标签让位", () => {
  const out = fitTabs({
    ...base,
    width: 3 * 120 + 2 * 1,
    tabs: ["a", "b", "c", "d"],
    activeId: "d",
  });
  assert.deepEqual(out.visible, ["a", "b", "d"]);
  assert.deepEqual(out.overflow, ["c"]);
});

test("pinned 在末尾时仍然可见", () => {
  const out = fitTabs({
    ...base,
    width: 3 * 120 + 2 * 1,
    tabs: ["a", "b", "c", "d"],
    pinned: ["d"],
  });
  assert.deepEqual(out.visible, ["a", "b", "d"]);
  assert.deepEqual(out.overflow, ["c"]);
});

test("宽度小于一个标签时至少保留 active；没有 active 则保留第一个", () => {
  const withActive = fitTabs({ ...base, width: 50, tabs: ["a", "b", "c"], activeId: "c" });
  assert.deepEqual(withActive.visible, ["c"]);
  assert.deepEqual(withActive.overflow, ["a", "b"]);

  const withoutActive = fitTabs({ ...base, width: 50, tabs: ["a", "b", "c"] });
  assert.deepEqual(withoutActive.visible, ["a"]);
  assert.deepEqual(withoutActive.overflow, ["b", "c"]);
});

test("空列表返回空结果", () => {
  const out = fitTabs({ ...base, width: 500, tabs: [] });
  assert.deepEqual(out.visible, []);
  assert.deepEqual(out.overflow, []);
});

test("activeId 不在 tabs 里时当作没有 active，不抛异常", () => {
  const out = fitTabs({
    ...base,
    width: 2 * 120 + 1,
    tabs: ["a", "b", "c"],
    activeId: "missing",
  });
  assert.deepEqual(out.visible, ["a", "b"]);
  assert.deepEqual(out.overflow, ["c"]);
});

test("标签少时按最大宽度显示，不随容器拉宽", () => {
  const out = fitTabs({ ...base, width: 2000, tabs: ["a", "b"] });
  assert.deepEqual(out.visible, ["a", "b"]);
  assert.equal(out.tabWidth, 200, "两个标签也只给 maxW，不许拉伸成横幅");
});

test("标签变多时先收窄，收窄区间里全部可见、不出现溢出", () => {
  // 4 个标签、宽 800：(800 - 3) / 4 = 199.25 → 还没到 minW，按 199 显示
  const out = fitTabs({ ...base, width: 800, tabs: ["a", "b", "c", "d"] });
  assert.deepEqual(out.visible, ["a", "b", "c", "d"]);
  assert.deepEqual(out.overflow, []);
  assert.equal(out.tabWidth, 199);
  assert.ok(out.tabWidth > base.minW && out.tabWidth < base.maxW, "落在 min 与 max 之间");
});

test("收到最小宽度还放不下才进溢出，此时宽度就是最小值", () => {
  // 8 个标签、宽 500：等分 (500 - 7) / 8 = 61.6 < 120 → 溢出
  const tabs = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const out = fitTabs({ ...base, width: 500, tabs });
  assert.equal(out.tabWidth, base.minW);
  assert.deepEqual(out.visible, ["a", "b", "c", "d"]);
  assert.deepEqual(out.overflow, ["e", "f", "g", "h"]);
});

test("正好等于最小宽度时仍全部可见（边界不算溢出）", () => {
  const out = fitTabs({ ...base, width: 4 * 120 + 3 * 1, tabs: ["a", "b", "c", "d"] });
  assert.deepEqual(out.overflow, []);
  assert.equal(out.tabWidth, 120);
});

test("没给 maxW 时退化成固定宽度（老行为）", () => {
  const out = fitTabs({ width: 2000, minW: 120, gap: 1, tabs: ["a", "b"], pinned: [], activeId: null });
  assert.equal(out.tabWidth, 120);
});

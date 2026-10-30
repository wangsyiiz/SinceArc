import assert from "node:assert/strict";
import test from "node:test";
import { fitTabs } from "./tab-fit.ts";

const base = { minW: 120, gap: 1, pinned: [] as string[], activeId: null as string | null };

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

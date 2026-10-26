import assert from "node:assert/strict";
import test from "node:test";
import { computeTooltipPosition } from "./tooltip-position.ts";

const viewport = { width: 800, height: 600 };

test("上方放得下时显示在锚点上方", () => {
  const out = computeTooltipPosition({
    anchor: { top: 400, left: 300, width: 80, height: 20 },
    size: { width: 100, height: 40 },
    viewport,
  });
  assert.equal(out.side, "above");
  assert.equal(out.top, 354);
  assert.equal(out.left, 290);
});

test("上方放不下时翻到下方", () => {
  const out = computeTooltipPosition({
    anchor: { top: 20, left: 300, width: 80, height: 20 },
    size: { width: 100, height: 40 },
    viewport,
  });
  assert.equal(out.side, "below");
  assert.equal(out.top, 46);
});

test("上下都放不下时选剩余空间更大的一侧", () => {
  const out = computeTooltipPosition({
    anchor: { top: 100, left: 50, width: 20, height: 20 },
    size: { width: 100, height: 150 },
    viewport: { width: 200, height: 200 },
  });
  assert.equal(out.side, "above");
  assert.ok(out.top >= 0);
});

test("上下都放不下且下方更大时选下方", () => {
  const out = computeTooltipPosition({
    anchor: { top: 50, left: 50, width: 20, height: 20 },
    size: { width: 100, height: 150 },
    viewport: { width: 200, height: 200 },
  });
  assert.equal(out.side, "below");
});

test("上方没越界但剩余空间更小时翻到下方", () => {
  const out = computeTooltipPosition({
    anchor: { top: 70, left: 50, width: 20, height: 20 },
    size: { width: 100, height: 60 },
    viewport: { width: 200, height: 200 },
  });
  assert.equal(out.side, "below");
  assert.equal(out.top, 96);
});

test("水平左侧越界时夹回 8px", () => {
  const out = computeTooltipPosition({
    anchor: { top: 200, left: 0, width: 20, height: 20 },
    size: { width: 100, height: 40 },
    viewport,
  });
  assert.equal(out.left, 8);
});

test("水平右侧越界时夹回视口内", () => {
  const out = computeTooltipPosition({
    anchor: { top: 200, left: 780, width: 20, height: 20 },
    size: { width: 100, height: 40 },
    viewport,
  });
  assert.equal(out.left, 692);
});

test("窄视口下 left 不为负且不超出视口", () => {
  const out = computeTooltipPosition({
    anchor: { top: 100, left: 90, width: 20, height: 20 },
    size: { width: 160, height: 40 },
    viewport: { width: 200, height: 200 },
  });
  assert.ok(out.left >= 0);
  assert.ok(out.left + 160 <= 200);
});

test("gap 默认为 6", () => {
  const out = computeTooltipPosition({
    anchor: { top: 400, left: 300, width: 80, height: 20 },
    size: { width: 100, height: 40 },
    viewport,
  });
  assert.equal(out.top, 354);
});

test("显式 gap 参与上下定位", () => {
  const out = computeTooltipPosition({
    anchor: { top: 400, left: 300, width: 80, height: 20 },
    size: { width: 100, height: 40 },
    viewport,
    gap: 20,
  });
  assert.equal(out.top, 340);
});

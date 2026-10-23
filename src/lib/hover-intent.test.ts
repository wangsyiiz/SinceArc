import assert from "node:assert/strict";
import test from "node:test";
import { computeHoverPosition } from "./hover-intent.ts";

const viewport = { width: 1000, height: 800 };
const anchor = { top: 200, left: 600, right: 700, bottom: 220 };

test("左侧放得下时贴在锚点左侧", () => {
  const out = computeHoverPosition({ anchor, viewport, width: 340 });
  assert.equal(out.side, "left");
  assert.equal(out.left, 252);
  assert.equal(out.top, 200);
});

test("左侧放不下时翻到右侧", () => {
  const out = computeHoverPosition({
    anchor: { top: 200, left: 100, right: 180, bottom: 220 },
    viewport,
    width: 340,
  });
  assert.equal(out.side, "right");
  assert.equal(out.left, 188);
});

test("垂直方向与锚点对齐后夹进视口", () => {
  const out = computeHoverPosition({
    anchor: { top: 650, left: 600, right: 700, bottom: 670 },
    viewport,
    width: 340,
  });
  assert.equal(out.maxHeight, 360);
  assert.equal(out.top, 432);
  assert.ok(out.top + out.maxHeight <= viewport.height - 8);
});

test("顶部同样保留 8px 边距", () => {
  const out = computeHoverPosition({
    anchor: { top: 2, left: 600, right: 700, bottom: 22 },
    viewport,
    width: 340,
  });
  assert.equal(out.top, 8);
});

test("maxHeight 跟随视口高度并受 maxCard 限制", () => {
  const short = computeHoverPosition({
    anchor,
    viewport: { width: 1000, height: 300 },
    width: 340,
  });
  assert.equal(short.maxHeight, 284);

  const limited = computeHoverPosition({ anchor, viewport, width: 340, maxCard: 200 });
  assert.equal(limited.maxHeight, 200);
});

test("窄视口下左侧固定为 margin", () => {
  const out = computeHoverPosition({
    anchor: { top: 100, left: 150, right: 200, bottom: 120 },
    viewport: { width: 300, height: 500 },
    width: 340,
  });
  assert.equal(out.left, 8);
});

test("gap 与宽度参与左侧翻边计算", () => {
  const out = computeHoverPosition({
    anchor: { top: 100, left: 350, right: 500, bottom: 120 },
    viewport,
    width: 340,
    gap: 20,
  });
  assert.equal(out.side, "right");
  assert.equal(out.left, 520);
});

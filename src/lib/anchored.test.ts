import assert from "node:assert/strict";
import test from "node:test";
import { computeLayerPosition } from "./anchored.ts";

const viewport = { width: 800, height: 600 };

test("下方放得下时贴在下沿", () => {
  const out = computeLayerPosition({
    trigger: { top: 100, left: 50, width: 120, height: 20 },
    panel: { width: 200, height: 100 },
    viewport,
  });
  assert.equal(out.placement, "below");
  assert.equal(out.top, 126);
});

test("下方放不下、上方放得下时翻到上方", () => {
  const out = computeLayerPosition({
    trigger: { top: 500, left: 50, width: 120, height: 20 },
    panel: { width: 200, height: 100 },
    viewport,
  });
  assert.equal(out.placement, "above");
  assert.equal(out.top, 394);
});

test("prefer=above 且上方放得下时优先上方", () => {
  const out = computeLayerPosition({
    trigger: { top: 400, left: 50, width: 120, height: 20 },
    panel: { width: 200, height: 100 },
    viewport,
    prefer: "above",
  });
  assert.equal(out.placement, "above");
  assert.equal(out.top, 294);
});

test("两侧都放不下时取空间更大的一侧并夹进视口", () => {
  const out = computeLayerPosition({
    trigger: { top: 550, left: 50, width: 120, height: 20 },
    panel: { width: 200, height: 700 },
    viewport,
  });
  assert.equal(out.placement, "above");
  assert.ok(out.top >= 8);
});

test("align=end 时右缘对齐，越界时被夹住", () => {
  const aligned = computeLayerPosition({
    trigger: { top: 100, left: 300, width: 120, height: 20 },
    panel: { width: 100, height: 100 },
    viewport,
    align: "end",
  });
  assert.equal(aligned.left + 100, 420);

  const clamped = computeLayerPosition({
    trigger: { top: 100, left: -20, width: 60, height: 20 },
    panel: { width: 100, height: 100 },
    viewport,
    align: "end",
  });
  assert.equal(clamped.left, 8);
});

test("面板比视口宽时左边固定为 margin", () => {
  const out = computeLayerPosition({
    trigger: { top: 100, left: 20, width: 120, height: 20 },
    panel: { width: 900, height: 100 },
    viewport,
  });
  assert.equal(out.left, 8);
});

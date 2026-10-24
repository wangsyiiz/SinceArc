import assert from "node:assert/strict";
import test from "node:test";
import { shouldAcceptChunk, shouldSettleLate } from "./late-window.ts";

test("在飞轮次接收正文", () => {
  assert.equal(shouldAcceptChunk(true, 0, 1_000), true);
});

test("终态后的迟到窗口内接收正文", () => {
  assert.equal(shouldAcceptChunk(false, 6_000, 1_000), true);
});

test("迟到窗口结束后拒绝正文", () => {
  assert.equal(shouldAcceptChunk(false, 1_000, 1_001), false);
  assert.equal(shouldAcceptChunk(false, 1_000, 1_000), false);
});

test("迟到流静默 600ms 后 settle", () => {
  assert.equal(shouldSettleLate(1_000, 1_599), false);
  assert.equal(shouldSettleLate(1_000, 1_600), true);
});

test("settle 静默阈值可注入", () => {
  assert.equal(shouldSettleLate(1_000, 1_099, 100), false);
  assert.equal(shouldSettleLate(1_000, 1_100, 100), true);
});

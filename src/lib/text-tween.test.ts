import assert from "node:assert/strict";
import test from "node:test";
import { MIN_RATE_PER_SEC, SEAL_BUDGET_MS, SEAL_RATE_MAX, safeCut, stepTextTween } from "./text-tween.ts";

test("递增到达量下显示长度单调不减且不越界", () => {
  let show = 0;
  let target = 0;

  for (const increment of [45, 17, 44, 9]) {
    target += increment;
    for (let frame = 0; frame < 3; frame += 1) {
      const next = stepTextTween({ show, target, dtMs: 16 });
      assert.ok(next >= show, `第 ${frame} 帧出现倒退：${show} -> ${next}`);
      assert.ok(next <= target, `第 ${frame} 帧越过目标：${next} > ${target}`);
      show = next;
    }
  }

  assert.ok(show <= target);
});

test("大 gap 多帧推进也永不越过 target", () => {
  const target = 1_000_000;
  let show = 0;

  for (let frame = 0; frame < 1_000; frame += 1) {
    show = stepTextTween({ show, target, dtMs: 16 });
    assert.ok(show <= target);
  }
});

test("地板速度每帧至少推进，并且 10 字 gap 一帧约走 2 字", () => {
  const next = stepTextTween({ show: 0, target: 10, dtMs: 16 });
  assert.ok(next >= 1);
  assert.equal(next, 2);
  assert.ok(next <= 10);
  assert.equal(MIN_RATE_PER_SEC, 120);
});

test("target 小于 show 时直接收口到 target", () => {
  assert.equal(stepTextTween({ show: 90, target: 42, dtMs: 16 }), 42);
});

test("dt 非正数按 1ms 处理，不原地卡死", () => {
  assert.equal(stepTextTween({ show: 0, target: 100, dtMs: 0 }), 1);
  assert.equal(stepTextTween({ show: 0, target: 100, dtMs: -16 }), 1);
});

test("gap 越大单帧推进越多", () => {
  const small = stepTextTween({ show: 0, target: 10, dtMs: 16 });
  const large = stepTextTween({ show: 0, target: 45, dtMs: 16 });
  assert.ok(large > small, `${large} 应大于 ${small}`);
});

test("代理对截断回退一个码元，越界位置夹到文本范围", () => {
  assert.equal(safeCut("😀😀", 1), 0);
  assert.equal(safeCut("😀😀", 2), 2);
  assert.equal(safeCut("😀😀", 3), 2);
  assert.equal(safeCut("😀😀", 99), 4);
  assert.equal(safeCut("abc", -1), 0);
});

/* ---------- 收口的有界追帧（§14 R4，2026-10-26 修正） ---------- */

test("收口预算与每帧上限是写死的常数", () => {
  assert.equal(SEAL_BUDGET_MS, 600);
  assert.equal(SEAL_RATE_MAX, 3000);
});

test("收口后按剩余时间配速，不再用 gap/TAU 的比例律", () => {
  // 332 字 / 600ms：第一帧 9 字。若走比例律会给 45 字（gap/0.12），那等于又变成一闪。
  assert.equal(stepTextTween({ show: 0, target: 332, dtMs: 16, remainingMs: 600 }), 9);
});

test("收口后每帧最多约一行，大块不一次糊上去", () => {
  assert.equal(stepTextTween({ show: 0, target: 5000, dtMs: 16, remainingMs: 600 }), 48);
});

test("预算耗尽的那一帧直接拉满", () => {
  assert.equal(stepTextTween({ show: 200, target: 1383, dtMs: 16, remainingMs: 0 }), 1383);
  assert.equal(stepTextTween({ show: 200, target: 1383, dtMs: 16, remainingMs: -20 }), 1383);
});

test("收口追帧在预算内走完，且全程不越界", () => {
  for (const gap of [332, 1383, 5000]) {
    let show = 0;
    let elapsed = 0;
    let frames = 0;
    while (show < gap && elapsed < 2000) {
      show = stepTextTween({ show, target: gap, dtMs: 16, remainingMs: SEAL_BUDGET_MS - elapsed });
      elapsed += 16;
      frames += 1;
      assert.ok(show <= gap, `gap=${gap} 越过目标：${show}`);
    }
    assert.equal(show, gap, `gap=${gap} 没走完`);
    // 600ms 是 37.5 帧，留 2 帧容差给「剩余 ≤0 才拉满」的那一帧。
    assert.ok(frames <= 40, `gap=${gap} 用了 ${frames} 帧，超出预算`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { MIN_RATE_PER_SEC, safeCut, stepTextTween } from "./text-tween.ts";

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

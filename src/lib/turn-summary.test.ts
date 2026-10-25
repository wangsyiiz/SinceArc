import assert from "node:assert/strict";
import test from "node:test";

import { turnHeading, turnLabel } from "./turn-summary.ts";

test("轮头摘要只含轮序、时刻与结局，不含用户原文", () => {
  const turn = { at: "17:38", userText: "用户原文不该出现在轨迹面板里" };
  const heading = turnHeading(turn, 0, "已结束");

  assert.equal(heading, "第 1 轮 · 17:38 · 已结束");
  assert.ok(!heading.includes(turn.userText));
  assert.equal(turnLabel(2), "第 3 轮");
});

test("没有时刻时省略该段", () => {
  assert.equal(turnHeading({ at: "" }, 4, "进行中"), "第 5 轮 · 进行中");
});

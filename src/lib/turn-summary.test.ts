import assert from "node:assert/strict";
import test from "node:test";

import type { TFunction } from "i18next";
import { turnHeading, turnLabel } from "./turn-summary.ts";

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction;

test("轮头摘要只含轮序、时刻与结局，不含用户原文", () => {
  const turn = { at: "17:38" };
  const heading = turnHeading(turn, 0, "已结束", t);

  assert.equal(heading, 'trace.turn.label:{"index":1} · 17:38 · 已结束');
  assert.equal(turnLabel(2, t), 'trace.turn.label:{"index":3}');
});

test("没有时刻时省略该段", () => {
  assert.equal(
    turnHeading({ at: "" }, 4, "进行中", t),
    'trace.turn.label:{"index":5} · 进行中',
  );
});

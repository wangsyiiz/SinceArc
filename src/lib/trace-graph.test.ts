import { test } from "node:test";
import assert from "node:assert/strict";

import { turnHasDrawableContent } from "./trace-adapter.ts";

const ids = new Set(["a1", "a2"]);
const has = (id: string) => ids.has(id);

test("有活动的轮要铺行", () => {
  const turn = { branches: [{ playerId: "m", activityIds: ["a1"], status: "done" as const }] };
  assert.equal(turnHasDrawableContent(turn, has), true);
});

test("没活动但有分支回复：也要铺行（回复本身是内容）", () => {
  const turn = {
    branches: [{ playerId: "m", activityIds: [], reply: "答完了", status: "done" as const }],
  };
  assert.equal(turnHasDrawableContent(turn, has), true);
});

test("0 活动 + 无回复的纯对话轮：不占行（§19.6）", () => {
  const turn = { branches: [{ playerId: "m", activityIds: [], status: "done" as const }] };
  assert.equal(turnHasDrawableContent(turn, has), false);
});

test("多支线里只要有一条有活动就铺行", () => {
  const turn = {
    branches: [
      { playerId: "m1", activityIds: [], status: "done" as const },
      { playerId: "m2", activityIds: ["a2"], status: "done" as const },
    ],
  };
  assert.equal(turnHasDrawableContent(turn, has), true);
});

test("活动 id 不在活动表里（被截断/已清理）按没有内容处理", () => {
  const turn = { branches: [{ playerId: "m", activityIds: ["gone"], status: "done" as const }] };
  assert.equal(turnHasDrawableContent(turn, has), false);
});

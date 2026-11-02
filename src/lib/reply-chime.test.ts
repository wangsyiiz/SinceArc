import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chimeStillValid } from "./reply-chime.ts";

describe("chimeStillValid", () => {
  it("终态之后没有活动事件 → 该响", () => {
    assert.equal(chimeStillValid(1_000, undefined), true);
    assert.equal(chimeStillValid(1_000, null), true);
    assert.equal(chimeStillValid(1_000, 900), true);
    assert.equal(chimeStillValid(1_000, 1_000), true, "同一毫秒不算更新");
  });

  it("终态之后还有 agent 活动 → 不响（那是提前到达的终态）", () => {
    assert.equal(chimeStillValid(1_000, 1_001), false);
    assert.equal(chimeStillValid(1_000, 5_000), false);
  });
});

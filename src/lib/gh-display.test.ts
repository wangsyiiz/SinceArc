import assert from "node:assert/strict";
import test from "node:test";

import { capabilityMap, runDotClass, runTone } from "./gh-display.ts";

test("runTone：成功 / 进行中 / 失败 / 未知", () => {
  assert.equal(runTone("completed", "success"), "ok");
  assert.equal(runTone("in_progress"), "warn");
  assert.equal(runTone("completed", "failure"), "danger");
  assert.equal(runTone("completed", "cancelled"), "danger");
  assert.equal(runTone("completed", "skipped"), "unknown");
});

test("runDotClass 只返回既有颜色令牌", () => {
  assert.equal(runDotClass("completed", "success"), "bg-ok-1");
  assert.equal(runDotClass("queued"), "bg-warn-1");
  assert.equal(runDotClass("completed", "failure"), "bg-danger-1");
  assert.equal(runDotClass("completed", "neutral"), "bg-ink-3");
});

test("capabilityMap 按 action 建索引", () => {
  const map = capabilityMap([
    { action: "pr_merge", allowed: false, reason: "readonly" },
    { action: "run_rerun", allowed: true },
  ]);
  assert.equal(map.pr_merge?.reason, "readonly");
  assert.equal(map.run_rerun?.allowed, true);
  assert.deepEqual(capabilityMap(undefined), {});
});

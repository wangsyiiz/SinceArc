import assert from "node:assert/strict";
import test from "node:test";
import { describeUsage, formatTokens } from "./usage-format.ts";

test("formatTokens 三档", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(18_530), "18.5k");
  assert.equal(formatTokens(1_000_000), "1M");
});

test("describeUsage 正常档文字与 warn=false", () => {
  const out = describeUsage({ used: 18_530, size: 1_000_000, percent: 2 });
  assert.equal(out.text, "上下文 18.5k / 1M（2%）");
  assert.equal(out.warn, false);
});

test("describeUsage 82% 进入告警档", () => {
  const out = describeUsage({ used: 820_000, size: 1_000_000, percent: 82 });
  assert.equal(out.warn, true);
  assert.match(out.text, /可能会丢开头/);
});

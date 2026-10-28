import assert from "node:assert/strict";
import test from "node:test";
import type { TFunction } from "i18next";
import { describeUsage, formatTokens } from "./usage-format.ts";

type Call = { key: string; params?: Record<string, unknown> };

function fakeT(calls: Call[]): TFunction {
  return ((key: string, params?: Record<string, unknown>) => {
    calls.push({ key, params });
    return key;
  }) as unknown as TFunction;
}

test("formatTokens 三档", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(18_530), "18.5k");
  assert.equal(formatTokens(1_000_000), "1M");
});

test("describeUsage 正常档文字与 warn=false", () => {
  const calls: Call[] = [];
  const out = describeUsage({ used: 18_530, size: 1_000_000, percent: 2 }, fakeT(calls));
  assert.deepEqual(calls, [
    { key: "usage.line.normal", params: { used: "18.5k", size: "1M", percent: "2" } },
  ]);
  assert.equal(out.warn, false);
});

test("describeUsage 82% 进入告警档", () => {
  const calls: Call[] = [];
  const out = describeUsage({ used: 820_000, size: 1_000_000, percent: 82 }, fakeT(calls));
  assert.deepEqual(calls, [
    { key: "usage.line.warn", params: { used: "820k", size: "1M", percent: "82" } },
  ]);
  assert.equal(out.warn, true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { formatBytes, relativeTime } from "./relative-time.ts";

test("relativeTime 按当前时间给出相对文案", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");
  assert.equal(relativeTime("2026-11-03T09:00:00Z", "en", now), "1 hour ago");
  assert.equal(relativeTime("2026-11-03T08:00:00Z", "en", now), "2 hours ago");
});

test("relativeTime 遇到空值或坏值原样返回", () => {
  assert.equal(relativeTime("", "en"), "");
  assert.equal(relativeTime("not-a-date", "en"), "not-a-date");
});

test("formatBytes 覆盖空值、字节与 KB", () => {
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
});

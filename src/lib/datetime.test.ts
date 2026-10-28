import assert from "node:assert/strict";
import test from "node:test";

import { formatDateTime } from "./datetime.ts";

test("ISO8601 格式化成 YYYY-MM-DD HH:mm（本地时区）", () => {
  const local = new Date(2026, 9, 28, 9, 5, 0);
  assert.equal(formatDateTime(local.toISOString()), "2026-10-28 09:05");
});

test("补零覆盖个位数月份/日期/小时/分钟", () => {
  const local = new Date(2026, 0, 2, 3, 4, 0);
  assert.equal(formatDateTime(local.toISOString()), "2026-01-02 03:04");
});

test("解析不了的串原样返回，不显示 Invalid Date", () => {
  assert.equal(formatDateTime("not-a-date"), "not-a-date");
  assert.equal(formatDateTime(""), "");
});

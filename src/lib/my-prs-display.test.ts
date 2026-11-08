import assert from "node:assert/strict";
import test from "node:test";

import { badgeLabel, clockTime, prMenuRows, topItems } from "./my-prs-display.ts";

test("badgeLabel：0 / 非正数不渲染", () => {
  assert.equal(badgeLabel(0, false), null);
  assert.equal(badgeLabel(0, true), null);
  assert.equal(badgeLabel(-1, false), null);
});

test("badgeLabel：1..99 原数，满额显示 99+", () => {
  assert.equal(badgeLabel(1, false), "1");
  assert.equal(badgeLabel(42, false), "42");
  assert.equal(badgeLabel(99, false), "99");
  assert.equal(badgeLabel(8, true), "99+");
  assert.equal(badgeLabel(100, false), "99+");
});

test("topItems：只取前 N 条且不改原数组", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(topItems(items, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(topItems(items.slice(0, 3), 8), [1, 2, 3]);
  assert.deepEqual(topItems(items, 0), []);
  assert.deepEqual(items, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("clockTime：输出本地 hh:mm，坏值原样返回", () => {
  const local = new Date(2026, 10, 3, 9, 5);
  assert.equal(clockTime(local.toISOString()), "09:05");
  assert.equal(clockTime("not-a-date"), "not-a-date");
  assert.equal(clockTime(undefined), "");
});

test("prMenuRows：标题 / 编号 / 仓库 / 草稿前缀 / 上限", () => {
  const items = [
    {
      number: 142,
      title: "修 …",
      url: "https://github.com/cli/cli/pull/142",
      updatedAt: "2026-11-03T09:05:00Z",
      isDraft: false,
      repo: "cli/cli",
    },
    {
      number: 141,
      title: "加 …",
      url: "https://github.com/acme/web/pull/141",
      updatedAt: "2026-11-02T09:05:00Z",
      isDraft: true,
      repo: "acme/web",
    },
  ];

  const rows = prMenuRows(items, { draftLabel: "草稿", locale: "zh-CN", limit: 8 });
  assert.equal(rows[0]?.id, `cli/cli#${142}`);
  assert.equal(rows[0]?.label, "修 …");
  assert.equal(rows[0]?.hint, `#${142}`);
  assert.ok(rows[0]?.description.startsWith("cli/cli · "));
  assert.equal(rows[1]?.url, items[1].url);
  assert.ok(rows[1]?.description.startsWith("草稿 · acme/web · "));
  assert.equal(prMenuRows(items, { draftLabel: "草稿", locale: "zh-CN", limit: 1 }).length, 1);
});

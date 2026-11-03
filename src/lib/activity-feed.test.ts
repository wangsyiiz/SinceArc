import assert from "node:assert/strict";
import test from "node:test";

import { mergeActivity } from "./activity-feed.ts";

const run = (id: number, at: string) => ({
  id,
  title: `run ${id}`,
  status: "completed",
  conclusion: "success",
  createdAt: at,
  url: `https://example.test/run/${id}`,
});

const pr = (number: number, at: string) => ({
  number,
  title: `pr ${number}`,
  state: "open",
  updatedAt: at,
  url: `https://example.test/pr/${number}`,
});

const release = (tag: string, at?: string) => ({
  tagName: tag,
  name: `release ${tag}`,
  publishedAt: at,
  url: `https://example.test/release/${tag}`,
});

test("三份数据按时间倒序归并", () => {
  const feed = mergeActivity({
    runs: [run(1, "2026-11-03T08:00:00Z")],
    prs: [pr(2, "2026-11-03T10:00:00Z")],
    releases: [release("v1", "2026-11-03T09:00:00Z")],
  });
  assert.deepEqual(
    feed.map((item) => item.kind),
    ["pr", "release", "run"],
  );
});

test("同一时间戳按 run > pr > release 排序", () => {
  const at = "2026-11-03T10:00:00Z";
  const feed = mergeActivity({
    releases: [release("v1", at)],
    prs: [pr(1, at)],
    runs: [run(9, at)],
  });
  assert.deepEqual(
    feed.map((item) => item.kind),
    ["run", "pr", "release"],
  );
});

test("超过上限截断到 10 条", () => {
  const runs = Array.from({ length: 15 }, (_, index) =>
    run(index + 1, `2026-11-03T10:${String(index).padStart(2, "0")}:00Z`),
  );
  const feed = mergeActivity({ runs, prs: [], releases: [] });
  assert.equal(feed.length, 10);
  assert.equal(feed[0].kind === "run" ? feed[0].id : null, 15);
});

test("空输入返回空数组", () => {
  assert.deepEqual(mergeActivity({ runs: [], prs: [], releases: [] }), []);
});

test("缺时间的条目排在最后且不丢", () => {
  const feed = mergeActivity({
    runs: [run(1, "2026-11-03T08:00:00Z")],
    prs: [],
    releases: [release("draft"), release("v1", "2026-11-03T09:00:00Z")],
  });
  assert.equal(feed.length, 3);
  assert.equal(feed[0].kind, "release");
  assert.equal(feed[1].kind, "run");
  assert.equal(feed[2].kind, "release");
  assert.equal(feed[2].at, "");
});

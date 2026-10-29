import assert from "node:assert/strict";
import test from "node:test";
import {
  clearInFlight,
  listInFlight,
  reduceInFlight,
  type InFlightTool,
} from "./running-count.ts";

const call = (toolCallId: string, over: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: `tool ${toolCallId}`,
  status: "in_progress",
  ...over,
});

test("同一个 toolCallId 反复更新只占一条，startedAt 只在首见时记", () => {
  let table: Record<string, InFlightTool> = {};
  table = reduceInFlight(table, "acp-a", call("t1"), 1_000);
  for (let i = 1; i <= 10; i += 1) {
    table = reduceInFlight(table, "acp-a", call("t1", { title: `update ${i}` }), 1_000 + i);
  }
  const items = listInFlight(table);
  assert.equal(items.length, 1);
  assert.equal(items[0].startedAt, 1_000);
  assert.equal(items[0].title, "update 10");
});

test("title 缺失沿用已有标题，不写成空串", () => {
  let table = reduceInFlight({}, "acp-a", call("t1", { title: "Read file" }), 1);
  table = reduceInFlight(table, "acp-a", call("t1", { title: undefined }), 2);
  assert.equal(listInFlight(table)[0].title, "Read file");
});

test("已有条目的增量更新可以省略 status；未知状态仍然不猜", () => {
  let table = reduceInFlight({}, "acp-a", call("t1"), 1);
  table = reduceInFlight(table, "acp-a", call("t1", { status: undefined }), 2);
  assert.equal(listInFlight(table).length, 1);
  assert.equal(
    reduceInFlight(table, "acp-a", call("t2", { status: undefined }), 3),
    table,
  );
});

test("completed / failed 出队，未知状态不猜", () => {
  let table = reduceInFlight({}, "acp-a", call("t1"), 1);
  table = reduceInFlight(table, "acp-a", call("t2"), 2);
  table = reduceInFlight(table, "acp-a", call("t1", { status: "completed" }), 3);
  assert.deepEqual(
    listInFlight(table).map((item) => item.toolCallId),
    ["t2"],
  );
  table = reduceInFlight(table, "acp-a", call("t2", { status: "failed" }), 4);
  assert.equal(listInFlight(table).length, 0);
  assert.equal(
    reduceInFlight(table, "acp-a", call("t3", { status: "mystery" }), 5),
    table,
  );
});

test("没有 toolCallId 的 update 原样返回", () => {
  const table = reduceInFlight({}, "acp-a", call("t1"), 1);
  assert.equal(reduceInFlight(table, "acp-a", { status: "in_progress" }, 2), table);
  assert.equal(reduceInFlight(table, "acp-a", call("", {}), 2), table);
});

test("listInFlight 按 startedAt 升序，最久的最前", () => {
  let table = reduceInFlight({}, "acp-a", call("late"), 300);
  table = reduceInFlight(table, "acp-b", call("early"), 100);
  table = reduceInFlight(table, "acp-a", call("middle"), 200);
  assert.deepEqual(
    listInFlight(table).map((item) => item.toolCallId),
    ["early", "middle", "late"],
  );
});

test("clearInFlight 只清该 agent 名下的条目", () => {
  let table = reduceInFlight({}, "acp-a", call("a1"), 1);
  table = reduceInFlight(table, "acp-b", call("b1"), 2);
  const next = clearInFlight(table, "acp-a");
  assert.deepEqual(
    listInFlight(next).map((item) => `${item.acpSessionId}:${item.toolCallId}`),
    ["acp-b:b1"],
  );
  assert.equal(clearInFlight(next, "acp-a"), next);
  assert.equal(Object.keys(table).length, 2, "不改入参");
});

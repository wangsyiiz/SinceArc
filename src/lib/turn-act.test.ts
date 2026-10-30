import assert from "node:assert/strict";
import { test } from "node:test";
import type { Activity } from "../types.ts";
import { ensureRunningAct, shouldIgnoreAgentResult, streamActId } from "./turn-act.ts";

const act = (over: Partial<Activity> = {}): Activity => ({
  id: streamActId("acp-1"),
  playerId: "player-1",
  kind: "thinking",
  title: "思考中",
  status: "running",
  at: "2026-10-30T00:00:00Z",
  ...over,
});

const input = { id: streamActId("acp-1"), playerId: "player-1", title: "思考中", at: "2026-10-30T00:00:09Z" };

test("没有任何行时插入一行 running", () => {
  const next = ensureRunningAct([], input);
  assert.equal(next.length, 1);
  assert.equal(next[0].id, input.id);
  assert.equal(next[0].status, "running");
  assert.equal(next[0].kind, "thinking");
  assert.equal(next[0].at, input.at);
});

test("已有同 id 且 running：原样返回同一个数组（不重置 at）", () => {
  const acts = [act()];
  const next = ensureRunningAct(acts, input);
  assert.equal(next, acts);
  assert.equal(next[0].at, "2026-10-30T00:00:00Z");
});

test("上一轮同 id 已收尾（ok）：替换成新的 running 行，不堆叠", () => {
  const acts = [act({ status: "ok", title: "已结束" })];
  const next = ensureRunningAct(acts, input);
  assert.equal(next.length, 1);
  assert.equal(next[0].status, "running");
  assert.equal(next[0].at, input.at);
});

test("别的 id 的 running 行不受影响（群聊多成员）", () => {
  const other = act({ id: streamActId("acp-2"), playerId: "player-2" });
  const next = ensureRunningAct([other], input);
  assert.equal(next.length, 2);
  assert.ok(next.some((a) => a.id === streamActId("acp-2") && a.status === "running"));
  assert.ok(next.some((a) => a.id === input.id && a.status === "running"));
});

test("streamActId 的口径与收尾处一致", () => {
  assert.equal(streamActId("abc"), "act-stream-abc");
});

test("agent 让位结果 + 真轮在飞：忽略", () => {
  assert.equal(shouldIgnoreAgentResult("agent", true), true);
});

test("agent 让位结果 + 没有在飞真轮：不忽略", () => {
  assert.equal(shouldIgnoreAgentResult("agent", false), false);
});

test("真实轮终态（origin=null）+ 有在飞真轮：不忽略", () => {
  assert.equal(shouldIgnoreAgentResult(null, true), false);
});

test("空 origin + 有在飞真轮：不忽略", () => {
  assert.equal(shouldIgnoreAgentResult("", true), false);
});

/**
 * `tool_call` / `tool_call_update` → 活动行（docs/desktop-ux.md §21.3）。
 *
 * 这些断言盯的是三件肉眼难发现的错：
 * ① 增量里 `null` 把已有 rawInput 清掉（行突然只剩标题）；
 * ② `completed` 把行重置回「思考中」（短工具连着跑时标签来回跳）；
 * ③ rawInput 又写回 `detail`（主行与次行重复同一条命令）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { applyToolCallFields, reduceToolCall, type ToolCallState } from "./tool-call.ts";
import type { Activity } from "@/types";

const ACP = "acp-1";
const ACT_ID = `act-stream-${ACP}`;

function runningRow(over: Partial<Activity> = {}): Activity {
  return {
    id: ACT_ID,
    playerId: "agent",
    kind: "thinking",
    title: "思考中",
    status: "running",
    at: "12:00:00",
    ...over,
  };
}

/** 模拟 useAcpEvents 的一条 session/update：归约 → 写回行。 */
function dispatch(
  acts: Activity[],
  prev: ToolCallState | null,
  update: Record<string, unknown>,
): { acts: Activity[]; state: ToolCallState | null } {
  const reduced = reduceToolCall(prev, update);
  assert.ok(reduced, "应当被识别为 tool_call / tool_call_update");
  const next = reduced.fields ? applyToolCallFields(acts, ACT_ID, reduced.fields) : null;
  return { acts: next ?? acts, state: reduced.nextState };
}

test("tool_call 写进该 acpSid 的活动行：kind / title / body", () => {
  const { acts } = dispatch([runningRow()], null, {
    sessionUpdate: "tool_call",
    toolCallId: "call_abc",
    title: "Run build",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm run build" },
  });

  assert.equal(acts[0].kind, "execute");
  assert.equal(acts[0].title, "Run build");
  assert.equal(acts[0].body, "command: npm run build");
  // §21.1：rawInput 不进 detail，否则主行与次行重复同一条命令
  assert.equal(acts[0].detail, undefined);
  assert.equal(acts[0].status, "running");
});

test("tool_call 的 kind 映射只决定标签：fetch / other / 缺失 → plan / thinking", () => {
  const kinds = ["read", "edit", "delete", "move", "search", "execute", "fetch", "other", "think"];
  const expected = ["read", "edit", "edit", "edit", "search", "execute", "plan", "plan", "thinking"];
  kinds.forEach((kind, index) => {
    const { acts } = dispatch([runningRow()], null, {
      sessionUpdate: "tool_call",
      toolCallId: `call-${index}`,
      title: kind,
      kind,
      status: "in_progress",
      rawInput: {},
    });
    assert.equal(acts[0].kind, expected[index], `kind=${kind} 的映射`);
  });
  const { acts } = dispatch([runningRow()], null, {
    sessionUpdate: "tool_call",
    toolCallId: "call-none",
    title: "no kind",
    status: "in_progress",
  });
  assert.equal(acts[0].kind, "thinking");
});

test("completed 不重置活动行：title 与 body 保持最后一次调用", () => {
  const first = dispatch([runningRow()], null, {
    sessionUpdate: "tool_call",
    toolCallId: "call_abc",
    title: "Run build",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm run build" },
  });
  const before = first.acts[0];

  const reduced = reduceToolCall(first.state ?? null, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_abc",
    status: "completed",
  });
  assert.ok(reduced);
  assert.equal(reduced.fields, null, "completed 不产生行更新");
  assert.equal(before.kind, "execute");
  assert.equal(before.title, "Run build");
  assert.equal(before.body, "command: npm run build");

  const failed = reduceToolCall(reduced.nextState, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_abc",
    status: "failed",
  });
  assert.equal(failed?.fields, null, "failed 同样不重置");
});

test("tool_call_update 的 null 不覆盖已有 rawInput", () => {
  const first = dispatch([runningRow()], null, {
    sessionUpdate: "tool_call",
    toolCallId: "call_abc",
    title: "Run build",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm run build" },
  });

  // 只带 title 的增量：rawInput 字段整个缺席 / 显式 null
  const second = dispatch(first.acts, first.state, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_abc",
    title: "Run build (retry)",
    kind: null,
    status: "in_progress",
    rawInput: null,
  });
  assert.equal(second.acts[0].title, "Run build (retry)");
  assert.equal(second.acts[0].body, "command: npm run build");
  assert.equal(second.acts[0].kind, "execute");
});

test("截断形状：body 取 preview 首行", () => {
  const { acts } = dispatch([runningRow()], null, {
    sessionUpdate: "tool_call",
    toolCallId: "call_trunc",
    title: "Search",
    kind: "search",
    status: "in_progress",
    rawInput: { __truncated: true, bytes: 4096, preview: "command: rg\nsecond line" },
  });
  assert.equal(acts[0].body, "command: rg\nsecond line");
  assert.equal(acts[0].body?.split("\n")[0], "command: rg");
});

test("找不到活动行时不新建行；已收口的行也不改写", () => {
  const empty = applyToolCallFields([], ACT_ID, {
    kind: "execute",
    title: "Run build",
    body: "command: npm run build",
  });
  assert.equal(empty, null);

  const done = applyToolCallFields([runningRow({ status: "ok" })], ACT_ID, {
    kind: "execute",
    title: "Run build",
    body: "command: npm run build",
  });
  assert.equal(done, null);
});

test("非工具调用事件返回 null，不影响别的分支", () => {
  assert.equal(reduceToolCall(null, { sessionUpdate: "agent_message_chunk" }), null);
  assert.equal(reduceToolCall(null, undefined), null);
});

test("换 toolCallId 时从空状态起算，不继承上一个调用的字段", () => {
  const first = dispatch([runningRow()], null, {
    sessionUpdate: "tool_call",
    toolCallId: "call-a",
    title: "Read a",
    kind: "read",
    status: "in_progress",
    rawInput: { path: "a.ts" },
  });
  const second = dispatch(first.acts, first.state, {
    sessionUpdate: "tool_call",
    toolCallId: "call-b",
    title: "Run b",
    kind: "execute",
    status: "in_progress",
  });
  assert.equal(second.acts[0].kind, "execute");
  assert.equal(second.acts[0].title, "Run b");
  // 新调用没带 rawInput：body 不能沿用 a.ts
  assert.equal(second.acts[0].body, undefined);
});

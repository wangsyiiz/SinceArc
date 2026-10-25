import assert from "node:assert/strict";
import test from "node:test";

import { keyOf } from "./stream-key.ts";

test("同一会话的两个 messageId 各有一条流，互不覆盖", () => {
  const first = keyOf("acp-1", "msg-a");
  const second = keyOf("acp-1", "msg-b");
  assert.notEqual(first, second);
  assert.ok(first.includes("msg-a"));
  assert.ok(second.includes("msg-b"));

  const messages: Record<string, { id: string; text: string }> = {};
  messages[first] = { id: first, text: "第一段" };
  messages[second] = { id: second, text: "第二段" };
  assert.equal(Object.keys(messages).length, 2);
  assert.equal(messages[first].text, "第一段");
  assert.equal(messages[second].text, "第二段");
});

test("同一 messageId 续写同一槽", () => {
  const key = keyOf("acp-1", "msg-a");
  const streams: Record<string, string> = { [key]: "前半" };
  streams[key] += "后半";
  assert.equal(streams[key], "前半后半");
});

test("messageId 缺失时回落到旧的单槽键", () => {
  assert.equal(keyOf("acp-1"), "stream-acp-1");
  assert.equal(keyOf("acp-1", ""), "stream-acp-1");
  assert.equal(keyOf("acp-1", "   "), "stream-acp-1");
});

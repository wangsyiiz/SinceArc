import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@/types";
import { firstMessageOfTurn, hasNoTurnAttribution, locateTargetOf } from "./turn-anchors.ts";

const msg = (id: string, turnId?: string | null): Message => ({
  id,
  role: "player",
  playerId: "p1",
  atomKind: "text.agent",
  text: id,
  at: "10:00",
  turnId,
});

test("命中：返回该轮在消息顺序里的第一条", () => {
  const messages = [msg("m1", "turn-a"), msg("m2", "turn-b"), msg("m3", "turn-a")];
  assert.equal(firstMessageOfTurn(messages, "turn-a")?.id, "m1");
  assert.deepEqual(locateTargetOf(messages, "turn-b"), { kind: "ok", messageId: "m2" });
  assert.equal(hasNoTurnAttribution(messages), false);
});

test("老数据：一条带 turnId 的消息都没有", () => {
  const messages = [msg("old-1", null), { id: "old-2", role: "system", text: "提示", at: "10:00" }];
  assert.equal(firstMessageOfTurn(messages, "turn-a"), null);
  assert.equal(hasNoTurnAttribution(messages), true);
  assert.deepEqual(locateTargetOf(messages, "turn-a"), { kind: "legacy" });
  assert.deepEqual(locateTargetOf(messages, ""), { kind: "legacy" });
});

test("该轮没有正文：会话有轮归属，但请求的这一轮为空", () => {
  const messages = [msg("m1", "turn-a")];
  assert.equal(firstMessageOfTurn(messages, "turn-b"), null);
  assert.equal(hasNoTurnAttribution(messages), false);
  assert.deepEqual(locateTargetOf(messages, "turn-b"), { kind: "empty" });
});

test("空 turnId 不会误命中任何一条消息", () => {
  const messages = [msg("m1", "turn-a"), msg("blank", "")];
  assert.equal(firstMessageOfTurn(messages, ""), null);
  assert.equal(firstMessageOfTurn(messages, null), null);
  assert.equal(firstMessageOfTurn(messages, undefined), null);
  assert.deepEqual(locateTargetOf(messages, ""), { kind: "empty" });
});

test("空白 turnId 与 NULL 同义，也不会命中空白归属", () => {
  const messages = [msg("m1", " turn-a "), msg("blank", "   ")];
  assert.equal(firstMessageOfTurn(messages, "   "), null);
  assert.equal(firstMessageOfTurn(messages, " turn-a ")?.id, "m1");
  assert.deepEqual(locateTargetOf(messages, "   "), { kind: "empty" });
  assert.deepEqual(locateTargetOf([msg("blank", "   ")], "turn-a"), { kind: "legacy" });
});

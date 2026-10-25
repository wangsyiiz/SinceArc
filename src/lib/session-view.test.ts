import assert from "node:assert/strict";
import test from "node:test";

import { describeSource, resolveAcpSessionId } from "./session-view.ts";

test("解析顺序：会话记录优先，其次事件流学到的映射", () => {
  assert.equal(resolveAcpSessionId("acp-record", "acp-event"), "acp-record");
  assert.equal(resolveAcpSessionId(null, "acp-event"), "acp-event");
  assert.equal(resolveAcpSessionId(undefined, undefined, "acp-other"), "acp-other");
});

test("都没有就返回 null —— 不猜「连接当前会话」，不借别的会话", () => {
  assert.equal(resolveAcpSessionId(null, undefined, ""), null);
  assert.equal(resolveAcpSessionId("   ", null), null);
});

test("来源可解释：状态栏/门禁要能说清这个 id 是哪来的", () => {
  assert.equal(describeSource("acp-record", "acp-event"), "record");
  assert.equal(describeSource(null, "acp-event"), "event");
  assert.equal(describeSource(null, null), "none");
});

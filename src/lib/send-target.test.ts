import assert from "node:assert/strict";
import test from "node:test";

import { resolveSendPlan, resolveSendTarget } from "./send-target.ts";

test("own 有值 → 直接用这条界面会话自己的 ACP 会话", () => {
  assert.equal(resolveSendTarget({ own: "acp-own", connected: true }), "own");
  assert.equal(resolveSendTarget({ own: "acp-own", connected: false }), "own");
});

test("own 为空 + 未连接 → 先连接", () => {
  assert.equal(resolveSendTarget({ own: null, connected: false }), "need-connect");
  assert.equal(resolveSendTarget({ own: undefined, connected: false }), "need-connect");
});

test("own 为空 + 已连接 → 新建 ACP 会话", () => {
  assert.equal(resolveSendTarget({ own: null, connected: true }), "create");
  assert.equal(resolveSendTarget({ own: "", connected: true }), "create");
});

test("target 存在时永远用 target，不走三态", () => {
  for (const own of [null, undefined, "acp-own"]) {
    for (const connected of [false, true]) {
      assert.equal(resolveSendPlan({ target: { acpSessionId: "member" }, own, connected }), "target");
    }
  }
});

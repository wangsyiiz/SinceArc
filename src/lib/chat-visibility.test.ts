import assert from "node:assert/strict";
import test from "node:test";

import { chatVisibilityOf } from "./chat-visibility.ts";

test("已注册的 chat atomKind 可见", () => {
  assert.equal(chatVisibilityOf({ atomKind: "text.user" }), "text.user");
  assert.equal(chatVisibilityOf({ atomKind: "text.agent" }), "text.agent");
  assert.equal(chatVisibilityOf({ atomKind: "aside" }), "aside");
  assert.equal(chatVisibilityOf({ atomKind: "delegate.card" }), "delegate.card");
  assert.equal(chatVisibilityOf({ atomKind: "notice.system" }), "notice.system");
});

test("未注册或非 chat atomKind 不进聊天区", () => {
  assert.equal(chatVisibilityOf({ atomKind: "weird.kind" }), null);
  assert.equal(chatVisibilityOf({ atomKind: "thought" }), null);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCwdLocked } from "./cwd-lock.ts";
import type { Message } from "@/types";

const user = { id: "u1", at: "2026-11-02", atomKind: "chat.message", role: "user", text: "hi" } as Message;
const player = {
  id: "p1",
  at: "2026-11-02",
  atomKind: "chat.message",
  role: "player",
  playerId: "a1",
  text: "hello",
} as Message;
const system = { id: "s1", at: "2026-11-02", atomKind: "chat.system", role: "system", text: "已连接" } as Message;

describe("isCwdLocked", () => {
  it("新会话没消息 → 可改", () => {
    assert.equal(isCwdLocked([]), false);
    assert.equal(isCwdLocked(undefined), false);
    assert.equal(isCwdLocked(null), false);
  });

  it("只有 agent 输出和系统提示 → 仍然可改", () => {
    assert.equal(isCwdLocked([system, player]), false);
  });

  it("出现用户消息 → 锁定", () => {
    assert.equal(isCwdLocked([system, user]), true);
    assert.equal(isCwdLocked([player, user]), true);
  });
});

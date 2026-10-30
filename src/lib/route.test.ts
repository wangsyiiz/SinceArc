import assert from "node:assert/strict";
import test from "node:test";

import { pathOfTab } from "./route.ts";

test("session 标签映射到 /session/<sessionId>", () => {
  assert.equal(pathOfTab({ kind: "session", sessionId: "s-1" }), "/session/s-1");
});

test("repo 标签映射到 /repo/<repoId>", () => {
  assert.equal(pathOfTab({ kind: "repo", repoId: "r-1" }), "/repo/r-1");
});

test("pr 标签映射到 /pr/<repoId>/<prNumber>", () => {
  assert.equal(pathOfTab({ kind: "pr", repoId: "r-1", prNumber: 42 }), "/pr/r-1/42");
});

test("settings 标签映射到 /settings", () => {
  assert.equal(pathOfTab({ kind: "settings" }), "/settings");
});

test("pr 缺 prNumber 返回 null", () => {
  assert.equal(pathOfTab({ kind: "pr", repoId: "r-1" }), null);
});

test("session 缺 sessionId 返回 null", () => {
  assert.equal(pathOfTab({ kind: "session" }), null);
});

test("repo 缺 repoId 返回 null", () => {
  assert.equal(pathOfTab({ kind: "repo" }), null);
});

test("未知 kind 返回 null", () => {
  assert.equal(pathOfTab({ kind: "unknown" }), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import { pathOfTab, repoViewOf } from "./route.ts";

test("session 标签映射到 /session/<sessionId>", () => {
  assert.equal(pathOfTab({ kind: "session", sessionId: "s-1" }), "/session/s-1");
});

test("repo 标签映射到 /repo/<repoId>", () => {
  assert.equal(pathOfTab({ kind: "repo", repoId: "r-1" }), "/repo/r-1");
});

test("repo dashboard 是缺省视图", () => {
  assert.equal(
    pathOfTab({ kind: "repo", repoId: "r-1", view: "dashboard" }),
    "/repo/r-1",
  );
});

test("repo 六个子页各自映射到子路由", () => {
  for (const view of ["pulls", "issues", "actions", "releases", "code", "settings"] as const) {
    assert.equal(pathOfTab({ kind: "repo", repoId: "r-1", view }), `/repo/r-1/${view}`);
  }
});

test("repo 的未知 view 落回 dashboard", () => {
  assert.equal(
    pathOfTab({ kind: "repo", repoId: "r-1", view: "nope" as never }),
    "/repo/r-1",
  );
  assert.equal(repoViewOf("nope"), "dashboard");
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

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRepoPath } from "./repo-path.ts";

test("Windows 反斜杠统一成正斜杠", () => {
  assert.equal(normalizeRepoPath("C:\\source\\sincearc"), "C:/source/sincearc");
});

test("去掉尾部分隔符", () => {
  assert.equal(normalizeRepoPath("/home/me/repo/"), "/home/me/repo");
  assert.equal(normalizeRepoPath("C:\\source\\sincearc\\\\"), "C:/source/sincearc");
});

test("盘符根保留结尾斜杠", () => {
  assert.equal(normalizeRepoPath("C:\\"), "C:/");
  assert.equal(normalizeRepoPath("D:/"), "D:/");
});

test("空串与根路径不误改", () => {
  assert.equal(normalizeRepoPath("   "), "");
  assert.equal(normalizeRepoPath("/"), "/");
});

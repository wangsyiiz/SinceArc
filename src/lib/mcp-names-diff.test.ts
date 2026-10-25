import assert from "node:assert/strict";
import test from "node:test";

import { diffMcpNames, needsReconnect } from "./mcp-names-diff.ts";

test("只增：新增项按新名单顺序返回，removed 为空", () => {
  assert.deepEqual(diffMcpNames(["a"], ["a", "b", "c"]), {
    removed: [],
    added: ["b", "c"],
  });
});

test("只减：删掉项按旧名单顺序返回，added 为空", () => {
  assert.deepEqual(diffMcpNames(["a", "b", "c"], ["a"]), {
    removed: ["b", "c"],
    added: [],
  });
});

test("既有新增也有删除", () => {
  assert.deepEqual(diffMcpNames(["a", "b"], ["b", "c"]), {
    removed: ["a"],
    added: ["c"],
  });
});

test("两份都空", () => {
  assert.deepEqual(diffMcpNames([], []), { removed: [], added: [] });
});

test("重连判据只看 removed", () => {
  assert.equal(needsReconnect(["a", "b"], ["a"]), true);
  assert.equal(needsReconnect(["a"], ["a", "b"]), false);
  assert.equal(needsReconnect(["a"], ["a"]), false);
  assert.equal(needsReconnect([], ["a"]), false);
});

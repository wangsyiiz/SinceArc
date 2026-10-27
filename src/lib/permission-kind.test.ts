import assert from "node:assert/strict";
import test from "node:test";

import { permissionKindKey } from "./permission-kind.ts";

test("权限 kind 映射为固定的五个 key", () => {
  assert.equal(permissionKindKey("execute"), "permission.kind.execute");
  assert.equal(permissionKindKey("edit"), "permission.kind.edit");
  assert.equal(permissionKindKey("delete"), "permission.kind.deleteMove");
  assert.equal(permissionKindKey("move"), "permission.kind.deleteMove");
  assert.equal(permissionKindKey("read"), "permission.kind.read");
  assert.equal(permissionKindKey("search"), "permission.kind.read");
});

test("未知或缺失的 kind 归到未分类，不猜具体类别", () => {
  assert.equal(permissionKindKey("fetch"), "permission.kind.uncategorized");
  assert.equal(permissionKindKey(""), "permission.kind.uncategorized");
  assert.equal(permissionKindKey(null), "permission.kind.uncategorized");
  assert.equal(permissionKindKey(undefined), "permission.kind.uncategorized");
});

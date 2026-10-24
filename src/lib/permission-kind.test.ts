import assert from "node:assert/strict";
import test from "node:test";

import { permissionKindLabel } from "./permission-kind.ts";

test("权限 kind 映射为固定的五类文案", () => {
  assert.equal(permissionKindLabel("execute"), "执行命令");
  assert.equal(permissionKindLabel("edit"), "编辑文件");
  assert.equal(permissionKindLabel("delete"), "删除/移动");
  assert.equal(permissionKindLabel("move"), "删除/移动");
  assert.equal(permissionKindLabel("read"), "读取");
  assert.equal(permissionKindLabel("search"), "读取");
});

test("未知或缺失的 kind 归到未分类，不猜具体类别", () => {
  assert.equal(permissionKindLabel("fetch"), "未分类");
  assert.equal(permissionKindLabel(""), "未分类");
  assert.equal(permissionKindLabel(null), "未分类");
  assert.equal(permissionKindLabel(undefined), "未分类");
});

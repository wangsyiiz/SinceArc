import assert from "node:assert/strict";
import test from "node:test";

import {
  autoApproveCovered,
  EDIT_KINDS,
  pickAllowOption,
  shouldAutoApprove,
} from "./auto-approve.ts";
import type { PermissionOption } from "./types.ts";

function options(...rows: Array<[string, PermissionOption["tone"]]>): PermissionOption[] {
  return rows.map(([id, tone]) => ({ id, label: id, tone }));
}

test("编辑类白名单只有 edit/delete/move", () => {
  assert.deepEqual(EDIT_KINDS, ["edit", "delete", "move"]);
});

test("关闭时不自动同意任何 kind", () => {
  for (const kind of ["edit", "delete", "move", "execute", "read", "search", null]) {
    assert.equal(shouldAutoApprove("off", kind), false);
  }
});

test("开启时只放行编辑类，未知/缺失/命令/读取都不放行", () => {
  assert.equal(shouldAutoApprove("edits", "edit"), true);
  assert.equal(shouldAutoApprove("edits", "delete"), true);
  assert.equal(shouldAutoApprove("edits", "move"), true);

  for (const kind of ["execute", "read", "search", "think", "fetch", "other", "unknown", "", null, undefined]) {
    assert.equal(shouldAutoApprove("edits", kind), false, String(kind));
  }
});

test("allow 选项按请求原顺序挑第一个，allow 与 always 同权", () => {
  const picked = pickAllowOption(
    options(["reject-1", "reject"], ["always-1", "always"], ["allow-1", "allow"]),
  );
  assert.equal(picked?.id, "always-1");
  assert.equal(picked?.tone, "always");

  assert.equal(pickAllowOption(options(["allow-1", "allow"], ["always-1", "always"]))?.id, "allow-1");
});

test("只有拒绝项或没有选项时不自动同意", () => {
  assert.equal(pickAllowOption(options(["reject-1", "reject"], ["reject-2", "reject"])), null);
  assert.equal(pickAllowOption([]), null);
  assert.equal(pickAllowOption(null), null);
  assert.equal(pickAllowOption(undefined), null);
});

test("agent 档 accept_edits / dont_ask 视为覆盖", () => {
  assert.equal(autoApproveCovered("accept_edits"), true);
  assert.equal(autoApproveCovered("dont_ask"), true);
  assert.equal(autoApproveCovered("default"), false);
  assert.equal(autoApproveCovered("unknown"), false);
  assert.equal(autoApproveCovered(null), false);
  assert.equal(autoApproveCovered(undefined), false);
});

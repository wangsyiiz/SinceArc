import assert from "node:assert/strict";
import { test } from "node:test";
import { isBetaVersion, versionLabel } from "./version-label.ts";

test("isBetaVersion：0.x 都是 beta", () => {
  assert.equal(isBetaVersion("0.0.8"), true);
  assert.equal(isBetaVersion("0.9.9"), true);
});

test("isBetaVersion：1.0.0 起不是 beta", () => {
  assert.equal(isBetaVersion("1.0.0"), false);
  assert.equal(isBetaVersion("12.3.4"), false);
});

test("isBetaVersion：解析不出来就不挂角标", () => {
  assert.equal(isBetaVersion(null), false);
  assert.equal(isBetaVersion(undefined), false);
  assert.equal(isBetaVersion(""), false);
  assert.equal(isBetaVersion("v0.0.8"), false);
  assert.equal(isBetaVersion("abc"), false);
});

test("versionLabel：补 v 前缀，幂等", () => {
  assert.equal(versionLabel("0.0.8"), "v0.0.8");
  assert.equal(versionLabel("v0.0.8"), "v0.0.8");
  assert.equal(versionLabel(" 0.0.8 "), "v0.0.8");
});

test("versionLabel：空值返回 null（调用方据此不渲染）", () => {
  assert.equal(versionLabel(null), null);
  assert.equal(versionLabel(undefined), null);
  assert.equal(versionLabel("   "), null);
});

/**
 * `@` 短名解析的回归测试（node --test，无需额外依赖）。
 *
 * 这些用例全部来自真实事故：`@hermes-测试2` 被 `[\w-]` 截成 `@hermes-`，
 * 发送时报「不在这个群里」。用已知短名匹配 + 边界 + 最长优先，才是对的。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { findMention, mentionToken } from "./mentions.ts";

const handles = ["hermes-测试2", "hermes-测试3", "backend", "backend2", "甲"];

test("中文短名可解析", () => {
  const hit = findMention("@hermes-测试2 看一下这个", handles);
  assert.equal(hit?.handle, "hermes-测试2");
  assert.equal(hit?.start, 0);
});

test("不会把长名截成短名（最长优先）", () => {
  const hit = findMention("@backend2 你来", handles);
  assert.equal(hit?.handle, "backend2");
});

test("短名后面必须断词：@backend3 不应命中 backend", () => {
  assert.equal(findMention("@backend3 你好", handles), null);
});

test("前面必须是行首或空白：邮箱里的 @ 不算提及", () => {
  assert.equal(findMention("a@backend 你好", handles), null);
});

test("单字短名可用", () => {
  const hit = findMention("麻烦 @甲 看一下", handles);
  assert.equal(hit?.handle, "甲");
});

test("未在群里的名字不产生命中", () => {
  assert.equal(findMention("@claude 你好", handles), null);
});

test("mentionToken 返回用户实际敲的名字（不带 @，去掉尾随标点），用于把报错说准", () => {
  assert.equal(mentionToken("@hermes-测试2 在吗"), "hermes-测试2");
  assert.equal(mentionToken("看看 @hermes-9，行吗"), "hermes-9");
  assert.equal(mentionToken("没有提及"), null);
});

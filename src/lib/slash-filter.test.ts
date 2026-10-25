import assert from "node:assert/strict";
import test from "node:test";

import { filterCommands, slashQuery } from "./slash-filter.ts";

const commands = [
  { name: "status", description: "show status" },
  { name: "steer", description: "steer the active turn" },
  { name: "compact", description: "compact" },
];

test("只输入 / 时列出全部命令", () => {
  assert.deepEqual(filterCommands("/", commands).map((c) => c.name), [
    "status",
    "steer",
    "compact",
  ]);
});

test("/st 命中 status 与 steer", () => {
  assert.deepEqual(filterCommands("/st", commands).map((c) => c.name), ["status", "steer"]);
});

test("前缀过滤不区分大小写", () => {
  assert.deepEqual(filterCommands("/ST", commands).map((c) => c.name), ["status", "steer"]);
});

test("空列表返回空", () => {
  assert.deepEqual(filterCommands("/", []), []);
});

test("/ 不在行首时不触发", () => {
  assert.equal(slashQuery("hello /st"), null);
  assert.equal(slashQuery("  /st"), "st");
});

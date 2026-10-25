import assert from "node:assert/strict";
import test from "node:test";

import { canSteer, steerGate, steerUnavailableReason } from "./steer-availability.ts";

test("没有 steer 命令时不可插话", () => {
  assert.equal(canSteer([{ name: "status" }], true), false);
  assert.equal(canSteer([], true), false);
});

test("有 steer 但正文从未带 messageId 时不可插话", () => {
  assert.equal(canSteer([{ name: "steer" }], false), false);
});

test("steer 命令与 messageId 都具备时才可插话", () => {
  assert.equal(canSteer([{ name: "steer" }], true), true);
});

test("三态：没声明 steer 是 off，声明了但没见过正文分组是 waiting", () => {
  assert.equal(steerGate([{ name: "status" }], true), "off");
  assert.equal(steerGate([{ name: "steer" }], false), "waiting");
  assert.equal(steerGate([{ name: "steer" }], true), "on");
});

test("waiting 不能被说成「不支持」——文案要区分没能力与还没探明", () => {
  assert.equal(steerUnavailableReason("off"), "这个 agent 不支持插话");
  assert.equal(steerUnavailableReason("waiting"), "正文出现后才能插话");
  assert.equal(steerUnavailableReason("on"), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import { canSteer } from "./steer-availability.ts";

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

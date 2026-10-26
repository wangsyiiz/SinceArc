import assert from "node:assert/strict";
import test from "node:test";

import { hintReducer, INITIAL_HINT_STATE } from "./hint-state.ts";

test("hover 打开后 close-request 正常收起", () => {
  const opened = hintReducer(INITIAL_HINT_STATE, { type: "open-request" });
  assert.deepEqual(opened, { open: true, pinned: false });
  assert.deepEqual(hintReducer(opened, { type: "close-request" }), {
    open: false,
    pinned: false,
  });
});

test("hover 打开后 pin，再点一次收起", () => {
  const hovered = hintReducer(INITIAL_HINT_STATE, { type: "open-request" });
  const pinned = hintReducer(hovered, { type: "toggle-pin" });
  assert.deepEqual(pinned, { open: true, pinned: true });
  assert.deepEqual(hintReducer(pinned, { type: "toggle-pin" }), {
    open: false,
    pinned: false,
  });
});

test("pin 状态下 pointerleave/blur 的关闭请求不生效", () => {
  const pinned = hintReducer(INITIAL_HINT_STATE, { type: "toggle-pin" });
  const afterLeave = hintReducer(pinned, { type: "close-request" });
  assert.deepEqual(afterLeave, { open: true, pinned: true });
  assert.equal(hintReducer(afterLeave, { type: "close-request" }), afterLeave);
});

test("Esc/点外 dismiss 收起 pin 态", () => {
  const pinned = hintReducer(INITIAL_HINT_STATE, { type: "toggle-pin" });
  assert.deepEqual(hintReducer(pinned, { type: "dismiss" }), {
    open: false,
    pinned: false,
  });
});

test("pin 态重复 open-request 不改变状态", () => {
  const pinned = hintReducer(INITIAL_HINT_STATE, { type: "toggle-pin" });
  assert.equal(hintReducer(pinned, { type: "open-request" }), pinned);
});

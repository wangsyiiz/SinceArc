import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUSY_INPUT_MODE,
  asBusyInputMode,
  dequeuePrompt,
  enqueuePrompt,
  queueCount,
  type QueuedPrompt,
} from "./busy-input.ts";

test("default busy input mode is interrupt", () => {
  assert.equal(DEFAULT_BUSY_INPUT_MODE, "interrupt");
});

test("known busy input modes are preserved", () => {
  assert.equal(asBusyInputMode("interrupt"), "interrupt");
  assert.equal(asBusyInputMode("queue"), "queue");
  assert.equal(asBusyInputMode("steer"), "steer");
});

test("dirty or missing busy input mode falls back to interrupt", () => {
  assert.equal(asBusyInputMode("later"), "interrupt");
  assert.equal(asBusyInputMode(null), "interrupt");
  assert.equal(asBusyInputMode(42), "interrupt");
});

test("queue appends in submission order without mutating input", () => {
  const base: QueuedPrompt[] = [{ id: "a", text: "first" }];
  const next = enqueuePrompt(base, { id: "b", text: "second" });
  assert.deepEqual(base.map((item) => item.id), ["a"]);
  assert.deepEqual(next.map((item) => item.text), ["first", "second"]);
});

test("queue dequeues the oldest prompt first", () => {
  const queue = [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ];
  const first = dequeuePrompt(queue);
  assert.equal(first.next?.id, "a");
  assert.deepEqual(first.rest.map((item) => item.id), ["b"]);
});

test("empty queue dequeues to null", () => {
  const result = dequeuePrompt([]);
  assert.equal(result.next, null);
  assert.deepEqual(result.rest, []);
});

test("queueCount reports the number of pending prompts", () => {
  assert.equal(queueCount([]), 0);
  assert.equal(queueCount([{ id: "a", text: "first" }]), 1);
});

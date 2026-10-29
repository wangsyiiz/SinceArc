import { test } from "node:test";
import assert from "node:assert/strict";

import {
  asNoticeSeverity,
  dismissNotice,
  pushNotice,
  type UiNotice,
} from "./notice-inbox.ts";

const note = (title: string, description = "detail", at = 1) => ({
  severity: "info" as const,
  title,
  description,
  at,
});

test("pushNotice adds a notice with count 1", () => {
  const list = pushNotice([], note("one"));
  assert.equal(list.length, 1);
  assert.equal(list[0]?.title, "one");
  assert.equal(list[0]?.count, 1);
  assert.equal(list[0]?.at, 1);
  assert.ok(list[0]?.id);
});

test("pushNotice folds identical title+description and increments count", () => {
  const first = pushNotice([], note("same"));
  const second = pushNotice(first, note("same", "detail", 2));
  assert.equal(second.length, 1);
  assert.equal(second[0]?.count, 2);
  assert.equal(second[0]?.id, first[0]?.id, "dedupe keeps the existing row/id");
});

test("pushNotice treats different description as a different notice", () => {
  const list = pushNotice(pushNotice([], note("same", "a")), note("same", "b"));
  assert.equal(list.length, 2);
});

test("unknown severity falls back to info", () => {
  assert.equal(asNoticeSeverity("_foo"), "info");
  assert.equal(asNoticeSeverity(undefined), "info");
  assert.equal(asNoticeSeverity("error"), "error");
  assert.equal(asNoticeSeverity("warning"), "warning");
  const list = pushNotice([], {
    severity: "_foo" as unknown as UiNotice["severity"],
    title: "unknown",
    at: 1,
  });
  assert.equal(list[0]?.severity, "info");
});

test("pushNotice keeps at most five notices and drops the oldest", () => {
  let list: UiNotice[] = [];
  for (let i = 0; i < 7; i += 1) list = pushNotice(list, note(`n${i}`, "d", i));
  assert.equal(list.length, 5);
  assert.deepEqual(
    list.map((entry) => entry.title),
    ["n2", "n3", "n4", "n5", "n6"],
  );
});

test("dismissNotice removes only the requested id", () => {
  const list = pushNotice(pushNotice([], note("a")), note("b"));
  const next = dismissNotice(list, list[0]!.id);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.title, "b");
});

test("pushNotice preserves oldest-first order", () => {
  const list = pushNotice(pushNotice([], note("first")), note("second"));
  assert.deepEqual(
    list.map((entry) => entry.title),
    ["first", "second"],
  );
});

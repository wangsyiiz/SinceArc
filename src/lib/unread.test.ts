import assert from "node:assert/strict";
import test from "node:test";
import { firstUnreadMessageId, unreadBadgeText } from "./unread.ts";

const message = (id: string, role: string) => ({ id, role });

test("zero unread has no jump target", () => {
  assert.equal(firstUnreadMessageId([message("m1", "player")], 0), null);
});

test("one unread points at that message", () => {
  assert.equal(
    firstUnreadMessageId(
      [message("u1", "user"), message("m2", "player")],
      1,
    ),
    "m2",
  );
});

test("multiple unread point at the earliest unread message", () => {
  assert.equal(
    firstUnreadMessageId(
      [
        message("old", "player"),
        message("u1", "user"),
        message("p1", "player"),
        message("s1", "system"),
        message("p2", "player"),
      ],
      2,
    ),
    "s1",
  );
});

test("unread count larger than memory falls back to the first available", () => {
  assert.equal(
    firstUnreadMessageId(
      [message("p1", "player"), message("p2", "player")],
      120,
    ),
    "p1",
  );
});

test("badge is hidden for zero", () => {
  assert.equal(unreadBadgeText(0), null);
});

test("badge shows small counts", () => {
  assert.equal(unreadBadgeText(5), "5");
});

test("badge caps at 99+", () => {
  assert.equal(unreadBadgeText(120), "99+");
});

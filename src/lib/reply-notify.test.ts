import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPLY_NOTIFY_COALESCE_MS,
  planReplyNotify,
  summarizeReply,
  type ReplyNotifyInput,
} from "./reply-notify.ts";

const base: ReplyNotifyInput = {
  soundEnabled: true,
  toastEnabled: true,
  windowFocused: true,
  viewingSession: true,
  stopReason: "end_turn",
  outcome: "ok",
};

test("focused and viewing the finished session stays silent", () => {
  assert.deepEqual(planReplyNotify(base), { sound: false, toast: false });
});

test("focused but viewing another session plays only sound", () => {
  assert.deepEqual(planReplyNotify({ ...base, viewingSession: false }), {
    sound: true,
    toast: false,
  });
});

test("unfocused plays sound and sends a notification", () => {
  assert.deepEqual(planReplyNotify({ ...base, windowFocused: false }), {
    sound: true,
    toast: true,
  });
});

test("cancelled turns never notify", () => {
  assert.deepEqual(
    planReplyNotify({ ...base, windowFocused: false, stopReason: "cancelled" }),
    { sound: false, toast: false },
  );
});

test("failed turns never notify even with a normal stop reason", () => {
  assert.deepEqual(
    planReplyNotify({ ...base, windowFocused: false, outcome: "failed" }),
    { sound: false, toast: false },
  );
});

test("missing stop reason never notifies", () => {
  assert.deepEqual(
    planReplyNotify({ ...base, windowFocused: false, stopReason: null }),
    { sound: false, toast: false },
  );
});

test("sound disabled keeps the toast when unfocused", () => {
  assert.deepEqual(
    planReplyNotify({ ...base, windowFocused: false, soundEnabled: false }),
    { sound: false, toast: true },
  );
});

test("toast disabled keeps the sound when unfocused", () => {
  assert.deepEqual(
    planReplyNotify({ ...base, windowFocused: false, toastEnabled: false }),
    { sound: true, toast: false },
  );
});

test("both switches off disables both channels", () => {
  assert.deepEqual(
    planReplyNotify({
      ...base,
      windowFocused: false,
      soundEnabled: false,
      toastEnabled: false,
    }),
    { sound: false, toast: false },
  );
});

test("sound disabled also silences the focused-other-session case", () => {
  assert.deepEqual(
    planReplyNotify({ ...base, viewingSession: false, soundEnabled: false }),
    { sound: false, toast: false },
  );
});

test("summarizeReply takes the first markdown line and strips markers", () => {
  assert.equal(summarizeReply("# **Done** with `build`\nsecond line"), "Done with build");
});

test("summarizeReply drops fence lines and keeps the first content line", () => {
  assert.equal(summarizeReply("```ts\nconst x = 1;\n```\n\n- shipped"), "const x = 1;");
});

test("summarizeReply strips link targets and hard line breaks", () => {
  assert.equal(summarizeReply("See [the diff](https://example.test/x)  \nmore"), "See the diff");
});

test("summarizeReply leaves underscores inside identifiers alone", () => {
  assert.equal(summarizeReply("keep snake_case intact"), "keep snake_case intact");
});

test("summarizeReply truncates to the requested character count with an ellipsis", () => {
  const result = summarizeReply("x".repeat(200));
  assert.equal(result.length, 120);
  assert.ok(result.endsWith("…"));
});

test("summarizeReply honors a custom maximum", () => {
  assert.equal(summarizeReply("abcdefghij", 5), "abcd…");
  assert.equal(summarizeReply("abcde", 5), "abcde");
});

test("summarizeReply treats empty and marker-only text as empty", () => {
  assert.equal(summarizeReply(""), "");
  assert.equal(summarizeReply("\n\n```\n```\n"), "");
  assert.equal(summarizeReply("anything", 0), "");
});

test("coalesce window is 800ms", () => {
  assert.equal(REPLY_NOTIFY_COALESCE_MS, 800);
});

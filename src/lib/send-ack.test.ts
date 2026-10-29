import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ABSORBED_SEND_THRESHOLD_MS,
  isAbsorbedSend,
  type SendTrace,
} from "./send-ack.ts";

const trace = (overrides: Partial<SendTrace> = {}): SendTrace => ({
  startedAt: 1_000,
  busyAtSend: true,
  sawStream: false,
  stopReason: "end_turn",
  resolvedAt: 1_200,
  ...overrides,
});

test("all three conditions hit -> absorbed", () => {
  assert.equal(isAbsorbedSend(trace()), true);
});

test("idle sends are never absorbed", () => {
  assert.equal(isAbsorbedSend(trace({ busyAtSend: false })), false);
});

test("unresolved sends are not absorbed", () => {
  assert.equal(isAbsorbedSend(trace({ resolvedAt: null })), false);
});

test("slow end_turn is not absorbed", () => {
  assert.equal(isAbsorbedSend(trace({ resolvedAt: 1_401 })), false);
});

test("any stream/thought/tool activity is not absorbed", () => {
  assert.equal(isAbsorbedSend(trace({ sawStream: true })), false);
});

test("non-end_turn stop reason is not absorbed", () => {
  assert.equal(isAbsorbedSend(trace({ stopReason: "cancelled" })), false);
  assert.equal(isAbsorbedSend(trace({ stopReason: null })), false);
});

test("the 400ms boundary counts as absorbed", () => {
  assert.equal(
    isAbsorbedSend(trace({ resolvedAt: 1_000 + ABSORBED_SEND_THRESHOLD_MS })),
    true,
  );
});

test("custom threshold is honored", () => {
  assert.equal(isAbsorbedSend(trace({ resolvedAt: 1_300 }), 299), false);
  assert.equal(isAbsorbedSend(trace({ resolvedAt: 1_300 }), 300), true);
});

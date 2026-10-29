import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_WINDOW_MAX,
  RUNNING_TURN_PIN_TAIL,
  WINDOW_EDGE,
  pinIndexes,
  planWindow,
} from "./messages-window.ts";

const bottom = (count: number, pinned?: number[]) =>
  planWindow({ count, firstVisible: count - 10, lastVisible: count - 1, pinned });

const top = (count: number, pinned?: number[]) =>
  planWindow({ count, firstVisible: 0, lastVisible: 10, pinned });

test("zero and small windows never trim", () => {
  assert.deepEqual(planWindow({ count: 0, firstVisible: 0, lastVisible: 0 }), {
    dropHead: 0,
    dropTail: 0,
  });
  assert.deepEqual(
    planWindow({ count: MESSAGE_WINDOW_MAX, firstVisible: 0, lastVisible: 249 }),
    { dropHead: 0, dropTail: 0 },
  );
});

test("one row over the hysteresis trims head at the bottom", () => {
  assert.deepEqual(bottom(MESSAGE_WINDOW_MAX + 1), { dropHead: 51, dropTail: 0 });
});

test("one row over the hysteresis trims tail at the top", () => {
  assert.deepEqual(top(MESSAGE_WINDOW_MAX + 1), { dropHead: 0, dropTail: 51 });
});

test("bottom edge trims back to the stable window", () => {
  assert.deepEqual(bottom(500), { dropHead: 300, dropTail: 0 });
});

test("top edge trims back to the stable window", () => {
  assert.deepEqual(top(500), { dropHead: 0, dropTail: 300 });
});

test("middle of the window does not trim", () => {
  assert.deepEqual(
    planWindow({ count: 500, firstVisible: 200, lastVisible: 260 }),
    { dropHead: 0, dropTail: 0 },
  );
});

test("top threshold is inclusive", () => {
  assert.deepEqual(
    planWindow({
      count: 400,
      firstVisible: WINDOW_EDGE,
      lastVisible: WINDOW_EDGE + 10,
    }),
    { dropHead: 0, dropTail: 200 },
  );
});

test("bottom threshold is inclusive", () => {
  const count = 400;
  assert.deepEqual(
    planWindow({
      count,
      firstVisible: count - WINDOW_EDGE - 10,
      lastVisible: count - 1 - WINDOW_EDGE,
    }),
    { dropHead: 200, dropTail: 0 },
  );
});

test("both edges: farther top wins and trims the tail", () => {
  assert.deepEqual(
    planWindow({ count: 400, firstVisible: 10, lastVisible: 395 }),
    { dropHead: 0, dropTail: 200 },
  );
});

test("both edges: farther bottom wins and trims the head", () => {
  assert.deepEqual(
    planWindow({ count: 400, firstVisible: 4, lastVisible: 380 }),
    { dropHead: 200, dropTail: 0 },
  );
});

test("equal edge distances use the bottom action", () => {
  assert.deepEqual(
    planWindow({ count: 400, firstVisible: 20, lastVisible: 379 }),
    { dropHead: 200, dropTail: 0 },
  );
});

test("pinned row at the head boundary shrinks the head trim", () => {
  assert.deepEqual(bottom(500, [50]), { dropHead: 50, dropTail: 0 });
});

test("pinned row inside the head crop keeps everything before it", () => {
  assert.deepEqual(bottom(500, [120, 240]), { dropHead: 120, dropTail: 0 });
});

test("pinned row at the tail boundary shrinks the tail trim", () => {
  assert.deepEqual(top(500, [499]), { dropHead: 0, dropTail: 0 });
  assert.deepEqual(top(500, [350]), { dropHead: 0, dropTail: 149 });
});

test("pinned rows outside the crop do not affect the plan", () => {
  assert.deepEqual(bottom(500, [350, 450]), { dropHead: 300, dropTail: 0 });
});

test("pinned rows can prevent a trim completely", () => {
  assert.deepEqual(bottom(500, [0, 1, 2]), { dropHead: 0, dropTail: 0 });
});

test("pinIndexes keeps streaming and unsent rows, sorted and deduplicated", () => {
  assert.deepEqual(
    pinIndexes({
      count: 10,
      streaming: [8, 2],
      undelivered: [2, 9],
      runningTurn: [],
    }),
    [2, 8, 9],
  );
});

test("pinIndexes only keeps running-turn rows inside the default tail window", () => {
  const count = 200;
  assert.deepEqual(
    pinIndexes({
      count,
      streaming: [],
      undelivered: [],
      runningTurn: [
        10,
        count - RUNNING_TURN_PIN_TAIL - 1,
        count - RUNNING_TURN_PIN_TAIL,
        count - 1,
      ],
    }),
    [count - RUNNING_TURN_PIN_TAIL, count - 1],
  );
});

test("pinIndexes running-turn boundary is inclusive", () => {
  assert.deepEqual(
    pinIndexes({
      count: 100,
      streaming: [],
      undelivered: [],
      runningTurn: [39, 40],
    }),
    [40],
  );
});

test("pinIndexes honours a custom tail window", () => {
  assert.deepEqual(
    pinIndexes({
      count: 100,
      streaming: [],
      undelivered: [],
      runningTurn: [79, 80, 89, 90],
      tailWindow: 10,
    }),
    [90],
  );
  assert.deepEqual(
    pinIndexes({
      count: 100,
      streaming: [],
      undelivered: [],
      runningTurn: [0, 50, 99],
      tailWindow: 100,
    }),
    [0, 50, 99],
  );
});

test("pinIndexes ignores invalid and out-of-range indexes", () => {
  assert.deepEqual(
    pinIndexes({
      count: 5,
      streaming: [-1, 1.5, 5, 2],
      undelivered: [4],
      runningTurn: [Number.NaN, 3, 8],
      tailWindow: 5,
    }),
    [2, 3, 4],
  );
});

test("pinIndexes returns nothing for an empty list", () => {
  assert.deepEqual(
    pinIndexes({
      count: 0,
      streaming: [0],
      undelivered: [0],
      runningTurn: [0],
    }),
    [],
  );
});

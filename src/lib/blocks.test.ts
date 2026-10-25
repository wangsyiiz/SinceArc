import assert from "node:assert/strict";
import test from "node:test";
import type { Atom } from "./atom.ts";
import { blocksOf } from "./blocks.ts";

function atom(seq: number, kind: string, refs: Record<string, string> = {}): Atom {
  return {
    id: `a${seq}`,
    sessionId: "s1",
    turnId: "t1",
    seq,
    at: seq * 100,
    actor: "agent",
    kind,
    schema: `${kind}/1`,
    payload: {},
    refs,
    ext: {},
    source: "live",
    truncated: false,
  };
}

test("stream：同 messageId 的连续 chunk 合成一块，被打断后回来另起一块", () => {
  const blocks = blocksOf([
    atom(1, "text.agent", { messageId: "m1" }),
    atom(2, "text.agent", { messageId: "m1" }),
    atom(3, "text.agent", { messageId: "m2" }),
    atom(4, "text.agent", { messageId: "m1" }),
  ]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((block) => block.atoms.length), [2, 1, 1]);
});

test("tool：tool_call 与两次 update 按 toolCallId 合成一块并按 seq 排序", () => {
  const blocks = blocksOf([
    atom(3, "tool_call_update", { toolCallId: "tool-1" }),
    atom(1, "tool_call", { toolCallId: "tool-1" }),
    atom(2, "tool_call_update", { toolCallId: "tool-1" }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].blockKind, "tool");
  assert.deepEqual(blocks[0].atoms.map((item) => item.seq), [1, 2, 3]);
});

test("request：permission 与 decision 按 requestId 合成一块", () => {
  const blocks = blocksOf([
    atom(1, "permission", { requestId: "req-1" }),
    atom(2, "permission_decision", { requestId: "req-1" }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].blockKind, "request");
  assert.equal(blocks[0].atoms.length, 2);
});

test("未注册 kind 保留为 single 块，不丢弃原子", () => {
  const future = atom(1, "future.thing");
  const blocks = blocksOf([future]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].blockKind, "single");
  assert.equal(blocks[0].primary, future);
  assert.deepEqual(blocks[0].atoms, [future]);
});

test("输出按块首原子的 seq 排序", () => {
  const blocks = blocksOf([
    atom(5, "usage"),
    atom(2, "future.thing"),
    atom(9, "commands"),
  ]);
  assert.deepEqual(blocks.map((block) => block.primary.seq), [2, 5, 9]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mergeMessages, minSeq } from "./messages-merge.ts";
import type { Message } from "@/types";

const msg = (id: string, text = id): Message =>
  ({ id, role: "agent", authorId: null, text, at: 0, streaming: false } as unknown as Message);

test("同一 id 只留一条，以后到的为准", () => {
  // 流式片段先到、落库后的完整文本后到：不能出现两条一样的消息
  const merged = mergeMessages([msg("m1", "半句")], [msg("m1", "半句，完整了")], { m1: 1 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "半句，完整了");
});

test("已知 seq 的按 seq 升序，前插的旧消息排在前面", () => {
  const seqs = { m1: 1, m2: 2, m3: 3 };
  // 先有 m2、m3（最新页），翻页后 m1 前插
  const merged = mergeMessages([msg("m2"), msg("m3")], [msg("m1")], seqs);
  assert.deepEqual(merged.map((m) => m.id), ["m1", "m2", "m3"]);
});

test("没有 seq 的流式消息稳定地留在已知历史之后", () => {
  const seqs = { m1: 1, m2: 2 };
  const merged = mergeMessages([msg("m1"), msg("s-live")], [msg("m2")], seqs);
  assert.deepEqual(merged.map((m) => m.id), ["m1", "m2", "s-live"]);
});

test("minSeq 取最小值；没有已知 seq 时为 null", () => {
  assert.equal(minSeq({ a: 5, b: 2, c: 9 }), 2);
  assert.equal(minSeq({}), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { extValue, refOf, type Atom } from "./atom.ts";

function atom(patch: Partial<Atom> = {}): Atom {
  return {
    id: "a1",
    sessionId: "s1",
    turnId: "t1",
    seq: 1,
    at: 100,
    actor: "agent",
    kind: "text.agent",
    schema: "text/1",
    payload: { text: "hi" },
    refs: {},
    ext: {},
    source: "live",
    truncated: false,
    ...patch,
  };
}

test("extValue 读取 x. 扩展键，未知键原样保留在 atom.ext", () => {
  const value = atom({ ext: { "x.demo.note": 1, junk: 2 } });
  assert.equal(extValue(value, "x.demo.note", 0), 1);
  assert.equal(value.ext.junk, 2);
});

test("extValue 不识别非 x. 键，缺失时返回 fallback", () => {
  const value = atom({ ext: { junk: 2 } });
  assert.equal(extValue(value, "junk", 9), 9);
  assert.equal(extValue(value, "x.demo.missing", 7), 7);
});

test("refOf 只返回字符串命名关联", () => {
  const value = atom({ refs: { messageId: "m1" } });
  assert.equal(refOf(value, "messageId"), "m1");
  assert.equal(refOf(value, "toolCallId"), undefined);
});

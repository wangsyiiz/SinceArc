import assert from "node:assert/strict";
import test from "node:test";
import { alignToTurns, isFullyAligned, normaliseTurnId, userTextOf } from "./turn-align.ts";

interface Msg {
  id: string;
  turnId?: string | null;
  role?: string;
  text?: string;
  seq?: number;
  /** 毫秒；只用来证明「时间远近不参与归轮」 */
  at?: number;
}

const m = (
  id: string,
  turnId: string | null | undefined,
  extra: Omit<Msg, "id" | "turnId"> = {},
): Msg => ({ id, turnId, role: "player", text: id, ...extra });

test("同一 turn_id 的消息归入同一轮，组内按 seq 升序", () => {
  const msgs = [m("m3", "turn-1", { seq: 3 }), m("m1", "turn-1", { seq: 1 }), m("m2", "turn-1", { seq: 2 })];
  const out = alignToTurns(msgs, ["turn-1"], { orderOf: (x) => x.seq });
  assert.deepEqual(
    out.byTurn.get("turn-1")?.map((x) => x.id),
    ["m1", "m2", "m3"],
  );
  assert.deepEqual(out.unassigned, []);
  assert.deepEqual(out.orphaned, []);
  assert.equal(isFullyAligned(out), true);
});

test("不同轮各自成组，轮的顺序不按时间重排", () => {
  const msgs = [m("b", "turn-b", { seq: 2 }), m("a", "turn-a", { seq: 1 })];
  // 故意让 turn-b 的 startedAt 更早：轮序只由调用方传入的 turnIds 决定
  const out = alignToTurns(msgs, ["turn-a", "turn-b"], { orderOf: (x) => x.seq });
  assert.deepEqual([...out.byTurn.keys()], ["turn-a", "turn-b"]);
  assert.deepEqual(out.byTurn.get("turn-a")?.map((x) => x.id), ["a"]);
  assert.deepEqual(out.byTurn.get("turn-b")?.map((x) => x.id), ["b"]);
});

test("空的轮也建出来，调用方不必判 null", () => {
  const out = alignToTurns([m("a", "turn-a")], ["turn-a", "turn-empty"]);
  assert.deepEqual(out.byTurn.get("turn-empty"), []);
});

test("turn_id 为 NULL 的老消息进「未分轮」，不并入任何一轮", () => {
  // 时间上正好夹在 turn-1 的两条消息中间 —— 旧实现会把它算进 turn-1
  const msgs = [
    m("m1", "turn-1", { seq: 1, at: 1_000 }),
    m("old", null, { seq: 2, at: 1_001 }),
    m("m2", "turn-1", { seq: 3, at: 1_002 }),
  ];
  const out = alignToTurns(msgs, ["turn-1"], { orderOf: (x) => x.seq });
  assert.deepEqual(out.byTurn.get("turn-1")?.map((x) => x.id), ["m1", "m2"]);
  assert.deepEqual(out.unassigned.map((x) => x.id), ["old"]);
  assert.equal(isFullyAligned(out), false);
});

test("没有 turn_id 时绝不按时间远近归轮（反回归）", () => {
  const msgs = [m("near", undefined, { at: 5_000 }), m("far", undefined, { at: 9_999 })];
  const out = alignToTurns(msgs, ["turn-1", "turn-2"]);
  assert.deepEqual(out.unassigned.map((x) => x.id), ["near", "far"]);
  assert.deepEqual(out.byTurn.get("turn-1"), []);
  assert.deepEqual(out.byTurn.get("turn-2"), []);
});

test("空白 turn_id 与 NULL 同义，不会造出叫 ' ' 的轮", () => {
  assert.equal(normaliseTurnId("   "), null);
  assert.equal(normaliseTurnId(""), null);
  assert.equal(normaliseTurnId(undefined), null);
  assert.equal(normaliseTurnId(" turn-1 "), "turn-1");

  const out = alignToTurns([m("blank", "   "), m("ok", " turn-1 ")], ["turn-1"]);
  assert.deepEqual(out.byTurn.get("turn-1")?.map((x) => x.id), ["ok"]);
  assert.deepEqual(out.unassigned.map((x) => x.id), ["blank"]);
});

test("指向视图外的轮（翻页没读到）单独成组，不并进未分轮", () => {
  const msgs = [m("old-turn-msg", "turn-0", { seq: 1 }), m("null-msg", null, { seq: 2 })];
  const out = alignToTurns(msgs, ["turn-1"], { orderOf: (x) => x.seq });
  assert.deepEqual(out.unassigned.map((x) => x.id), ["null-msg"]);
  assert.deepEqual(
    out.orphaned.map((entry) => [entry.turnId, entry.items.map((x) => x.id)]),
    [["turn-0", ["old-turn-msg"]]],
  );
});

test("缺 seq 的条目稳定排在有序条目之后", () => {
  const msgs = [m("live", "turn-1", { seq: undefined }), m("db2", "turn-1", { seq: 2 }), m("db1", "turn-1", { seq: 1 })];
  const out = alignToTurns(msgs, ["turn-1"], { orderOf: (x) => x.seq });
  assert.deepEqual(out.byTurn.get("turn-1")?.map((x) => x.id), ["db1", "db2", "live"]);
});

test("空输入不崩", () => {
  const out = alignToTurns<Msg>([], []);
  assert.equal(out.byTurn.size, 0);
  assert.deepEqual(out.unassigned, []);
  assert.deepEqual(out.orphaned, []);
  assert.equal(isFullyAligned(out), true);
});

test("userTextOf 只取该轮 user 消息，按顺序拼", () => {
  const items: Msg[] = [
    { id: "u1", role: "user", text: "第一句" },
    { id: "p1", role: "player", text: "回答不是正文" },
    { id: "u2", role: "user", text: "第二句" },
    { id: "s1", role: "system", text: "提示不算" },
  ];
  assert.equal(userTextOf(items), "第一句\n第二句");
  assert.equal(userTextOf([]), "");
});

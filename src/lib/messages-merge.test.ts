import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { maxSeq, mergeMessages, minSeq, replayVerdict } from "./messages-merge.ts";
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

test("maxSeq 取最大值；没有已知 seq 时为 null", () => {
  assert.equal(maxSeq({ a: 5, b: 2, c: 9 }), 9);
  assert.equal(maxSeq({}), null);
});

describe("前缀重复折叠（docs/acp-turn-synthesis.md §9）", () => {
  const agent = (id: string, text: string): Message => ({
    id,
    at: "2026-11-02T20:46:40CST",
    atomKind: "text.agent",
    role: "player",
    playerId: "agent",
    text,
  });
  const head =
    "修好了，并且在线上核对过，不是「合并即完成」。根因是 website/app.js 里的 const VERSION 写死成了 0.0.1；";
  const user: Message = {
    id: "u",
    at: "2026-11-02T20:50:15CST",
    atomKind: "text.user",
    role: "user",
    text: "继续说",
  };
  const notice: Message = {
    id: "n",
    at: "2026-11-02T20:58:11CST",
    atomKind: "notice",
    role: "system",
    text: "这一轮失败：agent closed stdout",
  };

  it("短的是长的严格前缀 → 只留长的那条（同一段回答落了两遍）", () => {
    const partial = agent("a", head);
    const full = agent("b", `${head}改成了 meta 单一来源。`);
    const out = mergeMessages([partial], [full], { a: 119, b: 126 });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });

  it("顺序反过来（长的那条先到）也折叠", () => {
    const out = mergeMessages([agent("b", `${head}尾巴`)], [agent("a", head)], { a: 119, b: 126 });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });

  it("中间隔着用户消息与失败通知也要折叠（重放会跨过它们）", () => {
    const out = mergeMessages(
      [agent("a", head)],
      [user, notice, agent("b", `${head}尾巴`)],
      { a: 119, u: 120, n: 125, b: 126 },
    );
    assert.equal(out.length, 3, "用户消息与通知保留，两条 agent 正文并成一条");
    assert.deepEqual(
      out.map((m) => m.id),
      ["b", "u", "n"],
      "完整版留在先出现的位置",
    );
  });

  it("太短的前缀不算（“好的”“继续”这种不算同一条）", () => {
    const out = mergeMessages([agent("a", "好的")], [agent("b", "好的，我这就开始改。")], {
      a: 1,
      b: 2,
    });
    assert.equal(out.length, 2);
  });

  it("不是前缀（只是同一句开头）不折叠", () => {
    const out = mergeMessages(
      [agent("a", `${head}甲方案`)],
      [agent("b", `${head}乙方案`)],
      { a: 1, b: 2 },
    );
    assert.equal(out.length, 2);
  });

  it("用户消息不会与 agent 正文折叠", () => {
    const userMsg: Message = { ...user, id: "u2", text: head };
    const out = mergeMessages([userMsg], [agent("b", `${head}尾巴`)], { u2: 1, b: 2 });
    assert.equal(out.length, 2);
  });
});

describe("replayVerdict（重放判据）", () => {
  const prev = "修好了，并且在线上核对过。**根因**：常量写死";

  it("累计内容仍是上一条的前缀 → 纯重放，丢弃", () => {
    assert.equal(replayVerdict(prev, "修好了"), "drop");
    assert.equal(replayVerdict(prev, prev), "drop");
  });

  it("越过上一条 → 续写，只接尾巴", () => {
    assert.equal(replayVerdict(prev, `${prev}，改成了 meta。`), "absorb");
  });

  it("与上一条无关 → 新消息", () => {
    assert.equal(replayVerdict(prev, "下面这段是新回答。"), "new");
    assert.equal(replayVerdict(null, "随便什么"), "new");
  });
});

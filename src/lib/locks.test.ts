import assert from "node:assert/strict";
import test from "node:test";
import { applyLock, summarizeLocks, type LockInfo } from "./locks.ts";

const p = (acp: string, player: string | null, title: string, count = 1) => ({
  acpSessionId: acp,
  playerId: player,
  title,
  count,
});

test("两个 agent 同时写时互不覆盖", () => {
  // 首版把锁存在单个槽位里，A 解锁会把 B 的提示一起清掉
  let locks: Record<string, LockInfo> = {};
  locks = applyLock(locks, p("acp-a", "u-1", "写 launch.rs"));
  locks = applyLock(locks, p("acp-b", "u-2", "写 fs.rs"));
  assert.equal(Object.keys(locks).length, 2);

  locks = applyLock(locks, { acpSessionId: "acp-a", playerId: null, title: "", count: 0 });
  assert.deepEqual(Object.keys(locks), ["acp-b"]);
  assert.equal(summarizeLocks(locks)?.title, "写 fs.rs");
});

test("同一个 agent 的并发写只更新计数与标题", () => {
  let locks: Record<string, LockInfo> = {};
  locks = applyLock(locks, p("acp-a", "u-1", "写 a.rs", 1));
  locks = applyLock(locks, p("acp-a", "u-1", "写 b.rs", 2));
  assert.equal(locks["acp-a"].count, 2);
  assert.equal(locks["acp-a"].title, "写 b.rs");
});

test("没有锁时 summarize 为 null；多锁时给出代表与额外计数", () => {
  assert.equal(summarizeLocks({}), null);
  const locks = {
    a: { playerId: "u-1", title: "写 a.rs", count: 1 },
    b: { playerId: "u-2", title: "写 b.rs", count: 1 },
  };
  const s = summarizeLocks(locks);
  assert.equal(s?.playerId, "u-1");
  assert.equal(s?.extra, 1);
});

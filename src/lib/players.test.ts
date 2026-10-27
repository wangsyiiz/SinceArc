import assert from "node:assert/strict";
import test from "node:test";

import { i18nText } from "./i18n-text.ts";
import { buildPlayers } from "./players.ts";

const kimi = {
  id: "m1",
  name: "Kimi",
  handle: "kimi",
  color: "var(--i3)",
  profileId: "p1",
};
const claude = {
  id: "m2",
  name: "Claude",
  handle: "claude",
  color: "var(--i3)",
  profileId: "p2",
};

test("在场成员正常解析，removed 为 false", () => {
  const players = buildPlayers({
    members: [kimi, claude],
    known: [kimi, claude],
    authorIds: ["m1", "m2"],
  });

  assert.deepEqual(
    players.map((player) => player.id),
    ["m1", "m2"],
  );
  assert.ok(players.every((player) => player.removed === false));
  assert.ok(players.every((player) => player.deleted !== true));
});

test("已移出成员仍能从全局成员解析身份", () => {
  const players = buildPlayers({
    members: [kimi],
    known: [kimi, claude],
    authorIds: ["m1", "m2"],
  });

  assert.deepEqual(players[1], {
    ...claude,
    removed: true,
  });
});

test("彻底删除的成员走灰色占位身份", () => {
  const players = buildPlayers({
    members: [],
    known: [],
    authorIds: ["gone"],
  });

  assert.deepEqual(players, [
    {
      id: "gone",
      name: i18nText("members.deleted"),
      handle: "",
      color: "var(--i3)",
      profileId: "",
      removed: true,
      deleted: true,
    },
  ]);
});

test("玩家不重复，顺序为成员优先、其次按历史作者出现顺序", () => {
  const players = buildPlayers({
    members: [claude, kimi],
    known: [kimi, claude],
    authorIds: ["m2", "m3", "m4", "m2", "m1", "m3"],
  });

  assert.deepEqual(
    players.map((player) => player.id),
    ["m2", "m1", "m3", "m4"],
  );
  assert.equal(new Set(players.map((player) => player.id)).size, players.length);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPermissionTurnSnapshot,
  PERMISSION_CLIENT_TIMEOUT_MS,
  permissionTimerKey,
  resolvePermissionTurn,
} from "./permission-timeout.ts";

test("本地超时对齐 Hermes approvals.timeout 的默认 300 秒", () => {
  assert.equal(PERMISSION_CLIENT_TIMEOUT_MS, 300_000);
});

test("计时器键按 profile + request 唯一", () => {
  assert.equal(permissionTimerKey("profile-a", 7), "profile-a:7");
  assert.notEqual(permissionTimerKey("profile-a", 7), permissionTimerKey("profile-b", 7));
});

test("快照三项全空才算空", () => {
  assert.equal(hasPermissionTurnSnapshot(null), false);
  assert.equal(hasPermissionTurnSnapshot(undefined), false);
  assert.equal(hasPermissionTurnSnapshot({}), false);
  assert.equal(hasPermissionTurnSnapshot({ profileId: null, acpSessionId: null, turnId: null }), false);

  assert.equal(hasPermissionTurnSnapshot({ profileId: "p" }), true);
  assert.equal(hasPermissionTurnSnapshot({ acpSessionId: "a" }), true);
  assert.equal(hasPermissionTurnSnapshot({ turnId: "t" }), true);
});

test("快照全空时才回退实时激活会话", () => {
  const live = { profileId: "live-p", acpSessionId: "live-a", turnId: "live-t" };
  assert.deepEqual(resolvePermissionTurn({}, live), live);
  assert.deepEqual(resolvePermissionTurn(null, live), live);
});

test("快照有任何一项就整组使用，不用实时值补缺", () => {
  assert.deepEqual(
    resolvePermissionTurn({ profileId: "snap-p" }, {
      profileId: "live-p",
      acpSessionId: "live-a",
      turnId: "live-t",
    }),
    { profileId: "snap-p", acpSessionId: null, turnId: null },
  );

  assert.deepEqual(
    resolvePermissionTurn(
      { profileId: "snap-p", acpSessionId: "snap-a", turnId: "snap-t" },
      { profileId: "live-p", acpSessionId: "live-a", turnId: "live-t" },
    ),
    { profileId: "snap-p", acpSessionId: "snap-a", turnId: "snap-t" },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentCaps } from "./ipc/types.gen/AgentCaps.ts";
import {
  delegateCapsDetail,
  delegateCapsLabel,
  delegateCapsNote,
  delegateErrorMessage,
  delegateReasonNote,
  delegateTargetCaps,
} from "./delegate-target.ts";

function caps(sessionFork: boolean): AgentCaps {
  return {
    loadSession: false,
    promptImage: false,
    promptAudio: false,
    promptEmbeddedContext: false,
    sessionList: false,
    sessionDelete: false,
    sessionFork,
    sessionResume: false,
    sessionClose: false,
    mcpHttp: false,
    mcpSse: false,
    mcpAcp: false,
  };
}

test("从没握手 → 档位未知", () => {
  assert.equal(delegateTargetCaps(undefined), "unknown");
  assert.equal(delegateTargetCaps({ caps: null }), "unknown");
  assert.equal(delegateCapsLabel("unknown"), "settings.memberDetail.delegateCaps.unknown");
  assert.equal(delegateCapsNote("unknown"), "delegate.caps.note.unknown");
});

test("sessionFork 为真 → 带 TA 的上下文，正常态不写额外说明", () => {
  assert.equal(delegateTargetCaps({ caps: caps(true) }), "member_fork");
  assert.equal(
    delegateCapsLabel("member_fork"),
    "settings.memberDetail.delegateCaps.memberFork",
  );
  assert.equal(delegateCapsNote("member_fork"), null);
});

test("sessionFork 为假 → 只带任务描述", () => {
  assert.equal(delegateTargetCaps({ caps: caps(false) }), "task_only");
  assert.equal(delegateCapsLabel("task_only"), "settings.memberDetail.delegateCaps.taskOnly");
  assert.equal(delegateCapsNote("task_only"), "delegate.caps.note.taskOnly");
});

test("降级成因逐条说人话，fork 是正常态不返回原因", () => {
  assert.equal(delegateReasonNote("fork"), null);
  assert.equal(delegateReasonNote("fork_unsupported"), "delegate.caps.reason.forkUnsupported");
  assert.equal(delegateReasonNote("fork_failed"), "delegate.caps.reason.forkFailed");
  assert.equal(delegateReasonNote("caps_unknown"), "delegate.caps.reason.capsUnknown");
  assert.equal(delegateReasonNote("member_missing"), "delegate.caps.reason.memberMissing");
  assert.equal(delegateReasonNote("未来新增的成因"), null, "不认识的原因不许编一句");

  // 轨迹里那一行：档位 + 成因；带上下文时只有档位
  assert.deepEqual(delegateCapsDetail("task_only", "fork_unsupported"), {
    labelKey: "settings.memberDetail.delegateCaps.taskOnly",
    reasonKey: "delegate.caps.reason.forkUnsupported",
  });
  assert.deepEqual(delegateCapsDetail("task_only", null), {
    labelKey: "settings.memberDetail.delegateCaps.taskOnly",
  });
  assert.deepEqual(delegateCapsDetail("member_fork", "fork"), {
    labelKey: "settings.memberDetail.delegateCaps.memberFork",
  });
});

test("六个错误码都说人话，未列出的码保留码兜底", () => {
  assert.deepEqual(delegateErrorMessage(50700, "Kimi"), {
    key: "delegate.error.notInGroup",
    params: { target: "Kimi" },
  });
  assert.deepEqual(delegateErrorMessage(50701, "Kimi"), { key: "delegate.error.taskEmpty" });
  assert.deepEqual(delegateErrorMessage(50702, "Kimi"), { key: "delegate.error.nested" });
  assert.deepEqual(delegateErrorMessage(50703, "Kimi"), { key: "delegate.error.limit" });
  assert.deepEqual(delegateErrorMessage(50704, "Kimi"), { key: "delegate.error.ended" });
  assert.deepEqual(delegateErrorMessage(50300, "Kimi"), {
    key: "delegate.error.connect",
    params: { target: "Kimi" },
  });
  assert.deepEqual(delegateErrorMessage(59999, "Kimi"), {
    key: "delegate.error.generic",
    params: { code: 59999 },
  });
});

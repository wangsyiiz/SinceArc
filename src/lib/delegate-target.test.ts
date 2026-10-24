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
  assert.equal(delegateCapsLabel("unknown"), "档位未知");
  assert.match(delegateCapsNote("unknown"), /按只带任务描述派/);
});

test("sessionFork 为真 → 带上下文，正常态不写额外说明", () => {
  assert.equal(delegateTargetCaps({ caps: caps(true) }), "inherited");
  assert.equal(delegateCapsLabel("inherited"), "带上下文");
  assert.equal(delegateCapsNote("inherited"), "");
});

test("sessionFork 为假 → 只带任务描述", () => {
  assert.equal(delegateTargetCaps({ caps: caps(false) }), "task_only");
  assert.equal(delegateCapsLabel("task_only"), "只带任务描述");
  assert.equal(
    delegateCapsNote("task_only"),
    "子任务看不到本会话历史，只拿到这段文字",
  );
});

test("降级成因逐条说人话，fork 是正常态不返回原因", () => {
  assert.equal(delegateReasonNote("fork"), "");
  assert.equal(delegateReasonNote("fork_unsupported"), "这个 agent 没报 fork 能力");
  assert.equal(delegateReasonNote("fork_failed"), "fork 失败，已按只带任务描述重跑");
  assert.equal(delegateReasonNote("caps_unknown"), "从没握手，不知道它支不支持");
  assert.equal(delegateReasonNote("parent_missing"), "父会话没有可 fork 的会话");
  assert.equal(delegateReasonNote("未来新增的成因"), "", "不认识的原因不许编一句");

  // 轨迹里那一行：档位 + 成因；带上下文时只有档位
  assert.equal(
    delegateCapsDetail("task_only", "fork_unsupported"),
    "只带任务描述 · 这个 agent 没报 fork 能力",
  );
  assert.equal(delegateCapsDetail("task_only", null), "只带任务描述");
  assert.equal(delegateCapsDetail("inherited", "fork"), "带上下文");
});

test("六个错误码都说人话，未列出的码保留码兜底", () => {
  assert.equal(delegateErrorMessage(50700, "Kimi"), "Kimi 不在这个群里");
  assert.equal(delegateErrorMessage(50701, "Kimi"), "任务正文为空或太长（上限 8KB）");
  assert.equal(delegateErrorMessage(50702, "Kimi"), "子任务不能再派活");
  assert.equal(delegateErrorMessage(50703, "Kimi"), "同时最多 3 个在跑，等一个回来再派");
  assert.equal(delegateErrorMessage(50704, "Kimi"), "这个派活已经结束或不属于当前会话");
  assert.equal(delegateErrorMessage(50300, "Kimi"), "Kimi 的连接没连上");
  assert.equal(delegateErrorMessage(59999, "Kimi"), "派活失败（59999）");
});

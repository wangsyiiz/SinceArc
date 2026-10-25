/**
 * 轨迹适配器的用例。
 *
 * 这些断言对应真实数据（2026-10-22 真机采集）：tool_call 与它的增量更新已由后端合并，
 * thought 超长被截断（正文进悬停卡片，并显示 truncated 提示），群聊里不同 author 走不同支线。
 * 映射错了的症状是「面板看起来有东西，但少一条 / 混到别人泳道里」—— 肉眼很难发现。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toTraceView } from "./trace-adapter.ts";
import type { TraceTurnDto } from "./ipc/types.ts";

const t0 = new Date("2026-10-22T17:38:00+08:00").getTime();

function turn(over: Partial<TraceTurnDto> = {}): TraceTurnDto {
  return {
    id: "turn-1",
    prompt: "现在几点",
    authorId: null,
    startedAt: t0,
    endedAt: t0 + 5000,
    status: "finished",
    items: [],
    ...over,
  };
}

test("工具调用与思考各自成为一条活动，用量被忽略", () => {
  const dto = turn({
    items: [
      { seq: 1, at: t0, authorId: null, kind: "tool_call", payload: { toolCallId: "c1", title: "terminal: date", kind: "execute", status: "completed" }, truncated: false },
      { seq: 2, at: t0 + 1, authorId: null, kind: "thought", payload: { text: "想一下时间" }, truncated: false },
      { seq: 3, at: t0 + 2, authorId: null, kind: "usage", payload: { used: 100, size: 1000 }, truncated: false },
    ],
  });
  const view = toTraceView([dto]);
  assert.equal(view.activities.length, 2, "usage 不该进轨迹：它是计量，不是「做了什么」");
  assert.equal(view.activities[0].kind, "execute");
  assert.equal(view.activities[0].title, "terminal: date");
  assert.equal(view.activities[1].kind, "thinking");
  assert.equal(view.turns[0].userText, "现在几点");
});

test("截断的思考带可见标记，不能只是被裁短", () => {
  const dto = turn({
    items: [
      { seq: 1, at: t0, authorId: null, kind: "thought", payload: { text: "很长的一段思考" }, truncated: true },
    ],
  });
  const view = toTraceView([dto]);
  assert.equal(view.activities[0].body, "很长的一段思考");
  assert.equal(view.activities[0].detail, "很长的一段思考");
  assert.equal(view.activities[0].truncated, true);
});

test("思考正文保留换行，摘要压成一行前 80 字", () => {
  const text = `${"甲".repeat(90)}\n第二行`;
  const dto = turn({
    items: [{ seq: 1, at: t0, authorId: null, kind: "thought", payload: { text }, truncated: false }],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.body, text);
  assert.equal(activity.detail, "甲".repeat(80));
});

test("工具卡片把 locations 逐行写入正文，摘要取第一个路径", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "tool_call",
        payload: {
          toolCallId: "c1",
          title: "读取文件",
          kind: "read",
          status: "completed",
          locations: [
            { path: "src/a.ts", line: 10, endLine: 12 },
            { path: "src/b.ts", range: { start: { line: 3 }, end: { line: 5 } } },
          ],
        },
        truncated: true,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.body, "src/a.ts:10-12\nsrc/b.ts:3-5");
  assert.equal(activity.detail, "读取文件");
  assert.equal(activity.truncated, true);
});

test("工具没有 locations 时正文保持 undefined", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "tool_call",
        payload: { toolCallId: "c1", title: "terminal: date", kind: "execute" },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.body, undefined);
  assert.equal(activity.detail, "terminal: date");
});

test("工具正文把 rawInput 对象逐行展开", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "tool_call",
        payload: {
          toolCallId: "c1",
          title: "terminal: rg",
          kind: "search",
          rawInput: { command: "rg", args: ["foo", "src"], cwd: "/tmp" },
        },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.body, 'command: rg\nargs: ["foo","src"]\ncwd: /tmp');
  assert.equal(activity.detail, "terminal: rg");
});

test("工具 rawInput 超过 2 KB 时截断并提示", () => {
  const long = "命令".repeat(900);
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "tool_call",
        payload: {
          toolCallId: "c1",
          title: "执行长命令",
          rawInput: { command: "echo", text: long },
        },
        truncated: false,
      },
    ],
  });
  const body = toTraceView([dto]).activities[0].body ?? "";
  assert.ok(body.length > 0);
  assert.ok(!body.includes(long), "超长 rawInput 不能整段进正文");
  assert.ok(!body.includes("\uFFFD"), "截断不能切坏多字节字符");
  assert.match(body, /…已截断 [1-9]\d* KB/);
});

test("工具正文展开 content 的文本与类型摘要", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "tool_call",
        payload: {
          toolCallId: "c1",
          title: "读取结果",
          content: [
            { type: "text", text: "第一行" },
            { type: "text", text: "第二行" },
            { type: "resource_link", name: "报告", uri: "file:///tmp/report.md" },
          ],
        },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.body, "第一行\n第二行\nresource_link: 报告");
});

test("工具字段的 __truncated 标记会写成可见提示", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "tool_call",
        payload: {
          toolCallId: "c1",
          title: "长输出",
          rawInput: { __truncated: true, bytes: 4096, preview: "command: rg" },
          content: { __truncated: true, bytes: 2048 },
        },
        truncated: true,
      },
    ],
  });
  const body = toTraceView([dto]).activities[0].body ?? "";
  assert.match(body, /command: rg/);
  assert.match(body, /已截断 4 KB/);
  assert.match(body, /已截断 2 KB/);
});

test("权限卡片列出选项名，摘要用斜线连接", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "permission",
        payload: {
          toolCall: { title: "执行 rm" },
          options: [
            { kind: "allow_once", optionId: "1", name: "允许一次" },
            { kind: "allow_always", optionId: "2", name: "总是允许" },
          ],
        },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.body, "允许一次\n总是允许");
  assert.equal(activity.detail, "允许一次 / 总是允许");
});

test("群聊里不同 author 分到不同支线", () => {
  const dto = turn({
    items: [
      { seq: 1, at: t0, authorId: null, kind: "tool_call", payload: { title: "主 agent 读文件", kind: "read" }, truncated: false },
      { seq: 2, at: t0 + 1, authorId: "u-2", kind: "tool_call", payload: { title: "成员写文件", kind: "edit" }, truncated: false },
      { seq: 3, at: t0 + 2, authorId: "u-2", kind: "permission", payload: { toolCall: { title: "执行 rm" } }, truncated: false },
    ],
  });
  const view = toTraceView([dto]);
  const branches = view.turns[0].branches;
  assert.equal(branches.length, 2, "两个作者 = 两条支线");
  const main = branches.find((b) => b.playerId === "agent");
  const member = branches.find((b) => b.playerId === "u-2");
  assert.equal(main?.activityIds.length, 1);
  assert.equal(member?.activityIds.length, 2);
  assert.match(view.activities[2].title, /请求权限：执行 rm/);
});

test("派活是一步进行中的活动，档位写在 detail", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "delegate",
        payload: {
          handleId: "dlg-1",
          targetName: "Kimi",
          task: "列出 md 文件",
          context: "task_only",
          reason: "fork_unsupported",
        },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.kind, "delegate");
  assert.equal(activity.title, "派活给 Kimi");
  assert.equal(
    activity.detail,
    "只带任务描述 · 这个 agent 没报 fork 能力",
    "档位必须带成因：用户要能对得上为什么这个 agent 没带上下文",
  );
  assert.equal(activity.status, "running", "结果没回来时派活仍在跑");
});

test("delegate_result 合进原步骤并转终态，不新增第二行", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "delegate",
        payload: {
          handleId: "dlg-1",
          targetName: "Kimi",
          context: "member_fork",
          reason: "fork",
        },
        truncated: false,
      },
      {
        seq: 2,
        at: t0 + 8123,
        authorId: null,
        kind: "delegate_result",
        payload: {
          handleId: "dlg-1",
          status: "finished",
          summary: "列完了",
          elapsedMs: 8123,
          stopReason: "end_turn",
        },
        truncated: false,
      },
    ],
  });
  const view = toTraceView([dto]);
  assert.equal(view.activities.length, 1);
  assert.equal(view.activities[0].title, "Kimi 回来了 · 8123ms");
  assert.equal(view.activities[0].detail, "带 TA 的上下文");
  assert.equal(view.activities[0].status, "ok");
});

test("派活失败时同一步写失败原因", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "delegate",
        payload: { handleId: "dlg-2", targetName: "Kimi", context: "task_only" },
        truncated: false,
      },
      {
        seq: 2,
        at: t0 + 900,
        authorId: null,
        kind: "delegate_result",
        payload: { handleId: "dlg-2", status: "failed", elapsedMs: 900, stopReason: "overloaded" },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.title, "Kimi 回来了 · 900ms");
  assert.equal(activity.detail, "overloaded");
  assert.equal(activity.status, "error");
});

test("用户停止的派活是已停止，不是还在跑也不是回来", () => {
  const dto = turn({
    status: "cancelled",
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "delegate",
        payload: { handleId: "dlg-3", targetName: "Kimi", context: "task_only" },
        truncated: false,
      },
      {
        seq: 2,
        at: t0 + 300,
        authorId: null,
        kind: "delegate_result",
        payload: { handleId: "dlg-3", status: "cancelled", elapsedMs: 300 },
        truncated: false,
      },
    ],
  });
  const activity = toTraceView([dto]).activities[0];
  assert.equal(activity.title, "Kimi 已停止");
  assert.equal(activity.status, "cancelled");
});

test("还在跑的轮次支线不收尾，结束的收尾", () => {
  const running = toTraceView([turn({ status: "running", endedAt: null })]);
  assert.equal(running.turns[0].branches.length, 0);
  const waiting = toTraceView([
    turn({
      status: "waiting_approval",
      endedAt: null,
      items: [{ seq: 1, at: t0, authorId: null, kind: "permission", payload: { toolCall: { title: "执行 rm" } }, truncated: false }],
    }),
  ]);
  assert.equal(waiting.turns[0].branches[0].status, "running", "等批准不是结束");
  const done = toTraceView([
    turn({
      items: [{ seq: 1, at: t0, authorId: null, kind: "thought", payload: { text: "x" }, truncated: false }],
    }),
  ]);
  assert.equal(done.turns[0].branches[0].status, "done");
});

test("轮次的 stopReason 透传，供抬头显示结局", () => {
  const view = toTraceView([turn({ status: "finished", stopReason: "max_tokens" })]);
  assert.equal(view.turns[0].stopReason, "max_tokens");
});

test("多轮按时间正序，最新一轮在最后", () => {
  const a = turn({ id: "turn-a", startedAt: t0 });
  const b = turn({ id: "turn-b", startedAt: t0 + 60_000 });
  const view = toTraceView([b, a]);
  assert.deepEqual(view.turns.map((t) => t.id), ["turn-a", "turn-b"]);
});

test("权限决定按请求里的 tool kind 显示批准分类", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "permission",
        payload: {
          toolCall: { title: "改文件", kind: "edit" },
          options: [
            { kind: "allow_once", optionId: "allow_once", name: "允许一次" },
            { kind: "reject_once", optionId: "reject_once", name: "拒绝" },
          ],
        },
        truncated: false,
      },
      {
        seq: 2,
        at: t0 + 1,
        authorId: null,
        kind: "permission_decision",
        payload: {
          requestId: 7,
          optionId: "allow_once",
          optionLabel: "允许一次",
          actorMemberId: null,
          via: "user",
          note: null,
          turnId: "turn-1",
        },
        truncated: false,
      },
    ],
  });
  const decision = toTraceView([dto]).activities[1];
  assert.equal(decision.kind, "permission");
  assert.equal(decision.title, "批准 · 编辑文件");
  assert.equal(decision.decision, "allow");
});

test("拒绝备注只进轨迹正文，不混进协议字段", () => {
  const dto = turn({
    items: [
      {
        seq: 1,
        at: t0,
        authorId: null,
        kind: "permission",
        payload: {
          toolCall: { title: "删除文件", kind: "delete" },
          options: [{ kind: "reject_once", optionId: "reject_once", name: "拒绝" }],
        },
        truncated: false,
      },
      {
        seq: 2,
        at: t0 + 1,
        authorId: null,
        kind: "permission_decision",
        payload: {
          requestId: 8,
          optionId: "reject_once",
          optionLabel: "拒绝",
          actorMemberId: null,
          via: "user",
          note: "先别删",
          turnId: "turn-1",
        },
        truncated: false,
      },
    ],
  });
  const decision = toTraceView([dto]).activities[1];
  assert.equal(decision.title, "拒绝（备注）");
  assert.equal(decision.decision, "reject");
  assert.match(decision.body ?? "", /备注：先别删/);
});

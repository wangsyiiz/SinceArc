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
  assert.equal(activity.detail, "src/a.ts");
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
  assert.equal(activity.detail, undefined);
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

test("还在跑的轮次支线不收尾，结束的收尾", () => {
  const running = toTraceView([turn({ status: "running", endedAt: null })]);
  assert.equal(running.turns[0].branches.length, 0);
  const done = toTraceView([
    turn({
      items: [{ seq: 1, at: t0, authorId: null, kind: "thought", payload: { text: "x" }, truncated: false }],
    }),
  ]);
  assert.equal(done.turns[0].branches[0].status, "done");
});

test("多轮按时间正序，最新一轮在最后", () => {
  const a = turn({ id: "turn-a", startedAt: t0 });
  const b = turn({ id: "turn-b", startedAt: t0 + 60_000 });
  const view = toTraceView([b, a]);
  assert.deepEqual(view.turns.map((t) => t.id), ["turn-a", "turn-b"]);
});

/**
 * running 活动行的四段视图（docs/desktop-ux.md §21.1 / §21.6）。
 *
 * 这里断言的是「DOM 里应该有几个元素」这一类规则：标签同一时刻只有一个、
 * body 空白时次行不存在（不是空 div）、count = 1 时没有 ×N。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { acpSessionIdOfActivity, activityRowView, firstNonBlankLine } from "./activity-row.ts";
import { i18nText } from "./i18n-text.ts";
import type { Activity } from "@/types";

function row(over: Partial<Activity> = {}): Activity {
  return {
    id: "act-stream-acp-1",
    playerId: "agent",
    kind: "thinking",
    title: "思考中",
    status: "running",
    at: "12:00:00",
    ...over,
  };
}

test("thinking 行只有「思考中」标签", () => {
  const view = activityRowView(row(), undefined);
  assert.equal(view.labelKey, "thinking.running");
  // 视图里只有一个标签字段：不存在「思考中 + 调用工具中」并列的第二个
  assert.deepEqual(Object.keys(view).sort(), [
    "bodyLine",
    "detail",
    "labelKey",
    "lock",
    "title",
  ]);
});

test("execute 行只有「调用工具中」标签", () => {
  const view = activityRowView(row({ kind: "execute", title: "npm run build" }), undefined);
  assert.equal(view.labelKey, "thinking.toolRunning");
  assert.equal(view.title, "npm run build");
});

test("thinking 行不重复显示「思考中」：占位标题让位给左侧标签", () => {
  const view = activityRowView(row({ title: i18nText("thinking.running") }), undefined);
  assert.equal(view.labelKey, "thinking.running");
  assert.equal(view.title, "");
  // 真正有内容的 think 标题照常显示
  assert.equal(activityRowView(row({ title: "Plan the edit" }), undefined).title, "Plan the edit");
});

test("有锁 count=2 → 图标 + ×2", () => {
  const view = activityRowView(row({ kind: "read" }), { title: "src/App.tsx", count: 2 });
  assert.ok(view.lock, "有锁时必须有图标");
  assert.equal(view.lock?.path, "src/App.tsx");
  assert.equal(view.lock?.tooltipKey, "thinking.lockTooltip");
  assert.equal(view.lock?.countText, "×2");
});

test("有锁 count=1 → 无 ×N", () => {
  const view = activityRowView(row(), { title: "src/App.tsx", count: 1 });
  assert.ok(view.lock);
  assert.equal(view.lock?.countText, null);
});

test("无 lock → 不渲染图标元素", () => {
  assert.equal(activityRowView(row(), undefined).lock, null);
});

test("次行取 body 首个非空行；空白/缺失时不渲染", () => {
  assert.equal(firstNonBlankLine("command: rg\nsecond"), "command: rg");
  assert.equal(firstNonBlankLine("\n  \ncommand: rg"), "command: rg");
  assert.equal(firstNonBlankLine("   "), null);
  assert.equal(firstNonBlankLine(""), null);
  assert.equal(firstNonBlankLine(undefined), null);

  assert.equal(activityRowView(row({ body: "command: rg" }), undefined).bodyLine, "command: rg");
  assert.equal(activityRowView(row({ body: "  \n\t" }), undefined).bodyLine, null);
  assert.equal(activityRowView(row(), undefined).bodyLine, null);
});

test("detail 只用于思考类；空白 detail 不占位", () => {
  assert.equal(activityRowView(row({ detail: "grep foo" }), undefined).detail, "grep foo");
  assert.equal(activityRowView(row({ detail: "   " }), undefined).detail, null);
});

test("从活动 id 还原 acpSessionId", () => {
  assert.equal(acpSessionIdOfActivity("act-stream-acp-1"), "acp-1");
  assert.equal(acpSessionIdOfActivity("act-other"), null);
});

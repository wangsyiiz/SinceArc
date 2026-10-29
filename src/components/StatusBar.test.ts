/**
 * 状态栏：事件信息搬进诊断、原位换成会话计时（docs/desktop-ux.md §25.2 / §25.3）。
 *
 * `node --test` 剥不了 JSX，做不了真实渲染，所以和 ThinkingRow / style-guard 一样读源码钉结构：
 * 事件 chip 不许回来了、计时必须在「有 sessionId 才渲染」这个条件下、事件数必须真的透传给诊断面板。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const statusBar = read("./StatusBar.tsx");
const diagnostics = read("./DiagnosticsPanel.tsx");

test("状态栏不再有事件 chip（EventStats 整块不存在）", () => {
  assert.equal(statusBar.includes("EventStats"), false);
  assert.equal(statusBar.includes("statusbar.events.short"), false);
});

test("事件数/最后一条透传给诊断面板，不再自成一段 UI", () => {
  assert.match(statusBar, /<DiagnosticsPanel[\s\S]{0,200}eventCount=\{eventCount\}/);
  assert.match(statusBar, /<DiagnosticsPanel[\s\S]{0,200}lastEvent=\{lastEvent\}/);
});

test("诊断面板顶部有摘要行，键沿用 statusbar.events.*", () => {
  assert.match(diagnostics, /t\("statusbar\.events\.received", \{ eventCount \}\)/);
  assert.match(diagnostics, /t\("statusbar\.events\.last", \{ lastEvent: lastEvent \?\? "-" \}\)/);
});

test("会话计时只在有 sessionId 时渲染，且位置在连接状态之前", () => {
  assert.match(statusBar, /\{sessionId && <SessionElapsed sessionId=\{sessionId\} \/>\}/);
  const elapsedAt = statusBar.indexOf("<SessionElapsed");
  const profileAt = statusBar.indexOf("<ProfileStatus");
  assert.ok(elapsedAt > 0 && profileAt > elapsedAt, "计时条应排在连接状态左侧");
});

test("计时条根元素带 data-session-elapsed，供探针与验收选择器使用", () => {
  const sessionElapsed = read("./SessionElapsed.tsx");
  assert.match(sessionElapsed, /data-session-elapsed/);
  assert.match(sessionElapsed, /Clock/);
  // 切换会话要重新起算：起点绑定在 sessionId 上
  assert.match(sessionElapsed, /\}, \[sessionId\]\);/);
  // 每秒一跳，卸载要清
  assert.match(sessionElapsed, /setInterval/);
  assert.match(sessionElapsed, /clearInterval/);
});

test("进行中计数渲染在会话计时之前，空列表默认不渲染", () => {
  const runningAt = statusBar.indexOf("<RunningCount");
  const elapsedAt = statusBar.indexOf("<SessionElapsed");
  assert.ok(runningAt > 0 && elapsedAt > runningAt, "计数应排在会话计时左侧");
  assert.match(statusBar, /<RunningCount items=\{running\} onOpenTrace=\{onOpenTrace\} \/>/);
  assert.match(statusBar, /running = \[\]/);
});

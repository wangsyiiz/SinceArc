/**
 * 状态栏「进行中」计数与悬停明细（docs/desktop-ux.md §26.4 / §26.6）。
 *
 * `node --test` 不能剥 JSX，这里和 ThinkingRow / StatusBar 一样读源码钉结构：
 * 0 条不渲染、悬停走 HoverCard、时长复用 formatElapsed、列表不截断且只能内部滚动。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const source = read("./RunningCount.tsx");

test("0 条时返回 null，不渲染「0 个」", () => {
  assert.match(source, /items\.length === 0\) return null/);
  assert.equal(source.includes("statusbar.running.empty"), false);
});

test("chip 带 data-running-count、Loader 与计数", () => {
  assert.match(source, /data-running-count/);
  assert.match(source, /import \{ Loader \} from "lucide-react"/);
  assert.match(source, /\{items\.length\}/);
  assert.match(source, /font-mono text-micro text-ink-3/);
});

test("悬停用 HoverCard，明细行是成员名 · title · 时长", () => {
  assert.match(source, /useHoverCard\(\)/);
  assert.match(source, /hover\.triggerProps/);
  assert.match(source, /hover\.card\(/);
  assert.match(source, /\{name\}/);
  assert.match(source, /\{title && \(/);
  assert.match(source, /formatElapsed\(nowMs - startedAt\)/);
  assert.match(source, /from "@\/lib\/session-elapsed"/);
});

test("每秒只刷新时长，卸载清理定时器", () => {
  assert.match(source, /setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 1000\)/);
  assert.match(source, /clearInterval\(timer\)/);
  assert.match(source, /function RunningDuration\(\{ startedAt \}/);
  assert.match(source, /<RunningDuration startedAt=\{startedAt\} \/>/);
  assert.match(source, /items\.map\(\(item, index\) => \(\s*<RunningRow/);
});

test("列表不设条数上限、没有「另有 N 个」，只给高度上限与内部滚动", () => {
  assert.match(source, /items\.map\(/);
  assert.match(source, /sc-running-card/);
  assert.match(source, /overflow-y-auto/);
  assert.equal(/slice\(0,\s*8\)/.test(source), false);
  assert.equal(/另有/.test(source), false);
  assert.equal(/另有 N 个/.test(source), false);
  assert.equal(/maxItems/.test(source), false);
});

test("超长 title 单行截断，不撑高卡片", () => {
  assert.match(source, /truncate/);
  assert.equal(source.includes("break-words"), false);
});

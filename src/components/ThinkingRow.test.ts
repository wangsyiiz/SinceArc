/**
 * running 活动行的结构断言（docs/desktop-ux.md §21.6）。
 *
 * `node --test` 不能剥 JSX，这里做不了真实 DOM 渲染；与 style-guard / data-plane 同样的做法：
 * 读源码，钉住「四段各自只有一个、条件渲染真的存在」。视图模型本身由
 * `lib/activity-row.test.ts` 覆盖，这里只验证组件确实按那份视图搭 DOM。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ThinkingRow.tsx", import.meta.url), "utf8");

/** running 分支：`view ? (` 到 `) : (` 之间。 */
function runningBranch(): string {
  const start = source.indexOf("{view ? (");
  const end = source.indexOf(") : (", start);
  assert.ok(start >= 0 && end > start, "找不到 running 分支");
  return source.slice(start, end);
}

test("running 分支只渲染一个标签，且取自 view.labelKey", () => {
  const branch = runningBranch();
  assert.equal(branch.match(/view\.labelKey/g)?.length, 1);
  // 历史分支的抖动三点只在 else 里，running 不该出现
  assert.equal(branch.includes("sc-dot"), false);
});

test("running 分支的次行用 view.bodyLine 条件渲染，不留空元素", () => {
  const branch = runningBranch();
  assert.match(branch, /\{view\.bodyLine && \(/);
});

test("锁图标与 ×N 各自条件渲染，图标来自 lucide-react 的 FileLock", () => {
  const branch = runningBranch();
  assert.match(source, /import \{[^}]*\bFileLock\b[^}]*\} from "lucide-react"/);
  assert.match(branch, /\{view\.lock && \(/);
  assert.match(branch, /\{view\.lock\.countText && \(/);
  assert.match(branch, /translateKey\(t, view\.lock\.tooltipKey, \{ path: view\.lock\.path \}\)/);
});

test("全局写提示已从输入区删除", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.equal(app.includes("writeHint"), false, "App.tsx 里不应再有 writeHint");
  assert.equal(app.includes("summarizeLocks"), false, "App.tsx 里不应再引用 summarizeLocks");
});

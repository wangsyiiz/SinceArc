/**
 * 数据面守卫（docs/data-plane.md §4）：`sessionsByProfile`（= 这条**连接**当前的会话）
 * 不许出现在展示/投递路径上。它只允许出现在连接管理内部与「这条连接是否已连上」的判断里。
 *
 * 为什么要有这条守卫：2026-10-25 的串台就是它被当成「你在看的这条会话」用的，
 * 而单会话场景下两者恰好相等，任何单会话用例都测不出来。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/** 从 src/lib/ 往上一级就是 src/。 */
const SRC = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 允许读「连接当前会话」的文件：连接管理本身，以及发送前的「连上了没」判断。 */
const ALLOWED_FILES = new Set([
  "hooks/useAcpEvents.ts", // 定义处：profile -> 当前会话
  "hooks/useAgentConnect.ts", // 连接/重连
  "hooks/usePrompt.ts", // 只用来判断这条 profile 是否已连接
]);

/** App.tsx 里只允许「连接尝试去重」的两处 key（形如 sessionsByProfile[pid]）。 */
const APP_ALLOWED = /sessionsByProfile\[\s*pid\s*\]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

test("展示/投递路径不许读「连接当前会话」", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("sessionsByProfile[")) return;
      if (ALLOWED_FILES.has(rel)) return;
      if (rel === "App.tsx" && APP_ALLOWED.test(line)) return;
      offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方把「连接当前会话」当成了会话的展示/投递数据源（见 docs/data-plane.md §2）：\n${offenders.join("\n")}`,
  );
});

test("活动会话的 ACP 会话 id 只从单一解析口来", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  const definitions = app.match(/const activeAcpSid = [^;]+;/g) ?? [];
  assert.equal(definitions.length, 1, `activeAcpSid 只能定义一次，实际 ${definitions.length} 次`);
  assert.match(
    definitions[0],
    /const activeAcpSid = acpSessionOf\(/,
    "activeAcpSid 必须走 acpSessionOf（唯一解析口），不许就地拼来源",
  );
});

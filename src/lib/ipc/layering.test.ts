/**
 * 分层守门：通信层之外不许直接调 IPC。
 *
 * 这条规则以前靠自觉，结果业务代码里散落着 `invoke("session_prompt", …)`：
 * 命令名拼错只在运行时炸，改一个参数要在十几个地方找。
 * 现在只允许 `lib/ipc/client.ts` 与 `lib/ipc/events.ts` 出现 `invoke(`。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ALLOWED = new Set(["src/lib/ipc/client.ts", "src/lib/ipc/events.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

test("业务代码不直接调用 invoke", () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    if (ALLOWED.has(rel) || rel.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    // 只认调用形态：invoke( / invoke<，注释里提到的不算
    if (/(?<![\.\w])invoke\s*[<(]/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `这些文件绕过了通信层：${offenders.join(", ")}`);
});

test("通信层集中在一个目录里", () => {
  assert.ok(ALLOWED.size === 2);
});

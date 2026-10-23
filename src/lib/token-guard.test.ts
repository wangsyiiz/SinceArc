/**
 * 令牌守门：代码里引用的每个 CSS 变量都必须在 styles.css 里有定义。
 *
 * 三个运行时变量只由组件内联写入，但 CSS 必须给出 fallback；否则变量尚未设置时
 * 整条声明会失效（分段控件曾经因此一直是直角）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");
const STYLES = join(SRC, "styles.css");
const RUNTIME_WRITTEN = ["--switch-index", "--switch-count", "--sb-alpha"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
        continue;
      }
      walk(path, out);
    } else if (/\.(ts|tsx|css)$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("代码引用的 CSS 令牌都有定义", () => {
  const css = readFileSync(STYLES, "utf8");
  const defined = new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]));
  const runtime = new Set(RUNTIME_WRITTEN);
  const errors: string[] = [];

  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const seen = new Set<string>();
    for (const match of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      if (defined.has(name) || runtime.has(name)) continue;
      errors.push(`${relative(ROOT, file).replaceAll("\\", "/")} 引用了未定义的令牌 ${name}`);
    }
  }

  for (const name of RUNTIME_WRITTEN) {
    const fallback = new RegExp(`var\\(\\s*${escapeRegExp(name)}\\s*,`);
    if (!fallback.test(css)) {
      errors.push(`styles.css 没有为运行时变量 ${name} 提供带 fallback 的用法`);
    }
  }

  assert.deepEqual(errors, [], `\n${errors.join("\n")}`);
});

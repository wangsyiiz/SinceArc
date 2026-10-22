/**
 * 设计语言 v2 的样式棘轮。
 *
 * 这里不修既有违规：先记录 P1 之前的真实命中，之后只允许减少。
 * 反向验证：在任一组件里新加一个 #ff0000，color-literal 的实际值会超过清单并让测试红。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { ALLOWED } from "./style-guard.allowlist.ts";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src");

const TEXT_RULES = [
  {
    id: "color-literal",
    re: /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/g,
  },
  {
    id: "arbitrary-value",
    re: /-\[[0-9]+px\]|-\[[0-9.]+rem\]/g,
  },
  {
    id: "native-control",
    re: /<select\b|type\s*=\s*["']checkbox["']/g,
  },
  {
    id: "transition-all",
    re: /transition-all|transition:\s*all/g,
  },
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "types.gen" || name.startsWith(".")) {
        continue;
      }
      walk(path, out);
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(new RegExp(re.source, re.flags))].length;
}

/**
 * `outline-none` 只看同一字符串里的替代焦点样式。
 * 当前违规都写在单个 className 字符串或 cn() 的单个参数里；拆到多个参数的情况目前没有。
 *
 * `outline-0` 是同一个意思（`outline-width: 0px`），P2b 里真被用来绕过了这条判据 ——
 * 判据照着 Tailwind 的两种写法一起认，否则改一个类名就能躲过棘轮。
 */
function countOutlineNone(text: string): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (quote !== "\"" && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }
    const start = index + 1;
    let end = start;
    while (end < text.length) {
      if (text[end] === "\\") {
        end += 2;
        continue;
      }
      if (text[end] === quote) break;
      end += 1;
    }
    const value = text.slice(start, end);
    const hidesOutline = value.includes("outline-none") || value.includes("outline-0");
    if (hidesOutline && !value.includes("focus-visible:")) count += 1;
    index = end + 1;
  }
  return count;
}

function scanActual(): Record<string, Record<string, number>> {
  const actual: Record<string, Record<string, number>> = {};
  for (const path of walk(SRC)) {
    const rel = relative(SRC, path).replaceAll("\\", "/");
    if (rel.startsWith("lib/style-guard.")) continue;

    const text = readFileSync(path, "utf8");
    const counts: Record<string, number> = {};
    for (const rule of TEXT_RULES) {
      const count = countMatches(text, rule.re);
      if (count > 0) counts[rule.id] = count;
    }
    const outline = countOutlineNone(text);
    if (outline > 0) counts["outline-none"] = outline;
    if (Object.keys(counts).length > 0) actual[rel] = counts;
  }
  return actual;
}

test("样式棘轮：违规只许减少，不许新增", () => {
  const actual = scanActual();
  const errors: string[] = [];
  const files = new Set([...Object.keys(actual), ...Object.keys(ALLOWED)]);

  for (const file of [...files].sort()) {
    const allowedEntries = ALLOWED[file] ?? [];
    if (!actual[file]) {
      errors.push(`清单已过期：${file} 当前扫描不到任何命中，应删除整文件条目`);
      continue;
    }

    const allowed = new Map(allowedEntries.map((entry) => [entry.rule, entry.count]));
    const rules = new Set([...Object.keys(actual[file]), ...allowed.keys()]);
    for (const rule of [...rules].sort()) {
      const found = actual[file][rule] ?? 0;
      const limit = allowed.get(rule) ?? 0;
      if (found > limit) {
        errors.push(`新增违规：${file} ${rule} ${found}/${limit}`);
      } else if (found < limit) {
        errors.push(`清单已过期，把这条删掉或改小：${file} ${rule} ${found}/${limit}`);
      }
    }
  }

  assert.deepEqual(errors, [], `\n${errors.join("\n")}`);
});

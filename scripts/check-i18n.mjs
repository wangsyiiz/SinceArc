#!/usr/bin/env node
/**
 * i18n 门禁（docs/i18n.md §6.1）：
 *
 * ① 两语言资源一致：key 集合相等、同 key 占位符集合相等、无空文案
 * ② 界面代码里不许有中文字面量（白名单：注释、`*.test.ts`、`src/i18n/**`、行尾 `// i18n-ignore`）
 *
 * 为什么要有 ②：类型只保证"用了 key"，拦不住有人直接写一行中文进 JSX —— 那种漏译在英文界面里
 * 就是一句中文，评审时最容易漏。0 处残留是收口条件。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = [];

/* ---------- ① 资源一致 ---------- */
const zhKeys = Object.keys(zhCN).sort();
const enKeys = Object.keys(en).sort();
const missingInEn = zhKeys.filter((k) => !(k in en));
const extraInEn = enKeys.filter((k) => !(k in zhCN));
if (missingInEn.length) problems.push(`en 缺 key（${missingInEn.length}）：${missingInEn.join(", ")}`);
if (extraInEn.length) problems.push(`en 多出 key（${extraInEn.length}）：${extraInEn.join(", ")}`);

const placeholders = (v) => [...String(v).matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();
for (const key of zhKeys) {
  if (!(key in en)) continue;
  const a = placeholders(zhCN[key]);
  const b = placeholders(en[key]);
  if (a.join(",") !== b.join(",")) problems.push(`占位符不一致 ${key}: zh=[${a}] en=[${b}]`);
  if (!String(zhCN[key]).trim()) problems.push(`中文空文案 ${key}`);
  if (!String(en[key]).trim()) problems.push(`英文空文案 ${key}`);
}

/* ---------- ② 中文字面量扫描 ---------- */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-dev", "target", ".git", "i18n"]);
const skipFile = (file) => /\.test\.tsx?$/.test(file) || /\.d\.ts$/.test(file);

function stripComments(line) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      i = end === -1 ? line.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !skipFile(name)) yield full;
  }
}

let residue = 0;
const byFile = new Map();
for (const file of walk(join(root, "src"))) {
  const rel = relative(root, file);
  const lines = readFileSync(file, "utf8").split("\n");
  let inBlockComment = false;
  lines.forEach((raw, idx) => {
    if (inBlockComment) {
      const end = raw.indexOf("*/");
      if (end === -1) return;
      inBlockComment = false;
    }
    if (raw.includes("i18n-ignore")) return;
    const code = stripComments(raw);
    if (code.includes("/*")) inBlockComment = true;
    if (CJK.test(code)) {
      residue += 1;
      byFile.set(rel, (byFile.get(rel) ?? 0) + 1);
    }
  });
}

if (residue) {
  const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  problems.push(`界面代码里还有中文（${residue} 处 / ${byFile.size} 个文件），最多的：\n` +
    top.map(([f, n]) => `    ${n}  ${f}`).join("\n"));
}

if (problems.length) {
  console.error("i18n 门禁未通过：\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(`\n  共 ${problems.length} 类问题`);
  process.exit(1);
}
console.log("i18n 门禁通过：资源一致 0 问题，界面代码 0 处残留");

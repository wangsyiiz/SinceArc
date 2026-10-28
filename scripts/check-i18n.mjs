#!/usr/bin/env node
/**
 * i18n 门禁（docs/i18n.md §6.1）：
 *
 * ① 两语言资源一致：key 集合相等、同 key 占位符集合相等、无空文案
 * ② 界面代码里不许有中文字面量（白名单：注释、`*.test.ts`、`src/i18n/**`、行尾 `// i18n-ignore`）
 * ③ Rust 里 `keyed*` 报上来的 `err.*` key 必须在 `zh-CN.ts` 中登记
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

/** 去掉行尾 `//` 注释（引号内的 `//` 不算）。块注释由调用方的循环处理。 */
function stripLineComments(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "/" && next === "/") break;
    out += ch;
  }
  return out;
}

/**
 * 去掉块注释，返回 [code, 是否还在块注释里]。
 *
 * 早先的实现靠「stripComments 后是否还含 `/*`」判断跨行，那是错的：剥离函数已经把注释扔了，
 * 于是多行文档注释体被当代码扫描，计数虚高。这里显式跟踪。
 */
function stripBlockComments(line, inBlock) {
  let rest = line;
  let code = "";
  let stillInBlock = inBlock;
  if (stillInBlock) {
    const end = rest.indexOf("*/");
    if (end === -1) return ["", true];
    rest = rest.slice(end + 2);
    stillInBlock = false;
  }
  for (;;) {
    const start = rest.indexOf("/*");
    if (start === -1) { code += rest; break; }
    const end = rest.indexOf("*/", start + 2);
    if (end === -1) { code += rest.slice(0, start); stillInBlock = true; break; }
    code += rest.slice(0, start);
    rest = rest.slice(end + 2);
  }
  return [code, stillInBlock];
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
  lines.forEach((raw) => {
    if (raw.includes("i18n-ignore")) return;
    const [noBlock, stillInBlock] = stripBlockComments(raw, inBlockComment);
    inBlockComment = stillInBlock;
    const code = stripLineComments(noBlock);
    if (CJK.test(code)) {
      residue += 1;
      byFile.set(rel, (byFile.get(rel) ?? 0) + 1);
    }
  });
}

if (residue) {
  const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  problems.push(`界面代码里还有中文（${residue} 处 / ${byFile.size} 个文件），最多的：\n` +
    top.map(([f, n]) => `    ${n}  ${f}`).join("\n"));
}

/* ---------- ③ Rust keyed key 必须存在于 zh-CN.ts ---------- */
/**
 * 从一次 `keyed(` / `keyed_with(` 调用里取第一个字符串字面量。
 *
 * 不按行扫：构造点常有跨行写法，而且 key 前面可能隔着数字、表达式。这里从开括号开始
 * 走到匹配的闭括号，遇到字符串就按转义规则跳过，既不会把下一处调用的 key 算进来，
 * 也不会被字符串里的括号带偏。
 */
function firstStringLiteral(source, openParen) {
  let depth = 1;
  for (let i = openParen + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"') {
      let value = "";
      i += 1;
      for (; i < source.length; i += 1) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          i += 1;
        } else if (source[i] === '"') {
          return value;
        } else {
          value += source[i];
        }
      }
      return null;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return null;
    }
  }
  return null;
}

function rustKeyedKeys(source) {
  const keys = [];
  const call = /\bkeyed(?:_with)?\s*\(/g;
  for (const match of source.matchAll(call)) {
    const openParen = match.index + match[0].length - 1;
    const value = firstStringLiteral(source, openParen);
    if (value?.startsWith("err.")) keys.push(value);
  }
  return keys;
}

function* walkRust(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkRust(full);
    else if (name.endsWith(".rs")) yield full;
  }
}

const missingRustKeys = new Map();
for (const file of walkRust(join(root, "src-tauri", "src"))) {
  const rel = relative(root, file);
  for (const key of rustKeyedKeys(readFileSync(file, "utf8"))) {
    if (!(key in zhCN)) {
      if (!missingRustKeys.has(key)) missingRustKeys.set(key, new Set());
      missingRustKeys.get(key).add(rel);
    }
  }
}
if (missingRustKeys.size) {
  const detail = [...missingRustKeys].map(([key, files]) => `${key}（${[...files].join(", ")}）`);
  problems.push(`Rust keyed key 未在 zh-CN.ts 登记（${missingRustKeys.size}）：${detail.join(", ")}`);
}

if (problems.length) {
  console.error("i18n 门禁未通过：\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(`\n  共 ${problems.length} 类问题`);
  process.exit(1);
}
console.log("i18n 门禁通过：资源一致 0 问题，界面代码 0 处残留，Rust keyed key 0 缺失");

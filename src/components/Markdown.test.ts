/**
 * 复制：代码块右上角按钮 + 行内 code 单击（docs/desktop-ux.md §25.1 / §25.4 第 1、2 条）。
 *
 * 关键不是「有没有按钮」，而是三条会被悄悄做错的规则：
 * ① 复制的是原始代码串（block.text），不是高亮 token 的 DOM 文本；
 * ② 行内 code 在有选区时不抢复制；
 * ③ copyText 只有一份实现（lib/clipboard.ts）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const markdown = read("./Markdown.tsx");
const clipboard = read("../lib/clipboard.ts");

test("copyText 只有一份实现：组件从 lib/clipboard 导入，不再本地定义", () => {
  assert.equal(/async function copyText/.test(markdown), false);
  assert.match(markdown, /import \{ copyText \} from "@\/lib\/clipboard"/);
  assert.match(clipboard, /export async function copyText/);
});

test("围栏代码块的复制按钮：不占布局、有 focus-visible、带探针属性", () => {
  assert.match(markdown, /data-code-copy/);
  const button = markdown.slice(markdown.indexOf("data-code-copy"));
  assert.match(button, /absolute/, "按钮必须绝对定位，不参与布局");
  assert.match(button, /focus-visible:/, "样式棘轮要求同 className 里有 focus-visible:");
  assert.match(button, /size-3/, "图标 12px");
});

test("代码块复制的是原始文本 block.text，不是 token 拼接", () => {
  assert.match(markdown, /<CodeCopyButton text=\{block\.text\} \/>/);
  assert.equal(/CodeCopyButton text=\{content\}/.test(markdown), false);
});

test("行内 code 单击复制，但有选区时不抢", () => {
  assert.match(markdown, /<InlineCode key=\{index\} text=\{inline\.text\} \/>/);
  assert.match(markdown, /window\.getSelection\(\)\?\.toString\(\)/);
  const inline = markdown.slice(markdown.indexOf("function InlineCode"));
  const guardAt = inline.indexOf("getSelection");
  const copyAt = inline.indexOf("copyText(text)");
  assert.ok(guardAt >= 0 && copyAt > guardAt, "选区判断必须在复制之前");
});

test("行内复制成功后给的是 data-copied 标记（样式在 styles.css，不撑行高）", () => {
  assert.match(markdown, /data-copied=\{state === "copied" \? "" : undefined\}/);
  assert.match(read("../styles.css"), /\.sc-prose code\[data-copied\]/);
});

test("复制失败的路径有显式反馈，不静默吞掉", () => {
  assert.match(markdown, /markdown\.code\.copyFailed/);
});

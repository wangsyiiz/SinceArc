import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parseMarkdown } from "./markdown.ts";
import type { Block, Inline } from "./markdown.ts";

type LinkInline = Extract<Inline, { kind: "link" }>;

function inlineText(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case "text":
        case "code":
          return inline.text;
        case "br":
          return "\n";
        case "strong":
        case "em":
        case "del":
        case "link":
          return inlineText(inline.children);
      }
    })
    .join("");
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return inlineText(block.children);
    case "code":
      return block.text;
    case "list":
      return block.items.flatMap((item) => item.map(blockText)).join("\n");
    case "quote":
      return block.blocks.map(blockText).join("\n");
    case "table":
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => inlineText(cell)).join(" | "))
        .join("\n");
    case "hr":
      return "";
  }
}

function blockInlines(block: Block): Inline[] {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return block.children;
    case "code":
    case "hr":
      return [];
    case "list":
      return block.items.flatMap((item) => item.flatMap(blockInlines));
    case "quote":
      return block.blocks.flatMap(blockInlines);
    case "table":
      return [...block.header, ...block.rows.flat()].flat();
  }
}

function collectLinks(inlines: Inline[], links: LinkInline[] = []): LinkInline[] {
  for (const inline of inlines) {
    if (inline.kind === "link") {
      links.push(inline);
      collectLinks(inline.children, links);
    } else if (inline.kind === "strong" || inline.kind === "em" || inline.kind === "del") {
      collectLinks(inline.children, links);
    }
  }
  return links;
}

test("块级白名单按 token 顺序归一：标题 / 有序列表 / 嵌套无序列表 / 表格 / 代码 / 引用 / 分隔线", () => {
  const src = [
    "## 标题",
    "",
    "1. 一",
    "   - 嵌套一",
    "   - 嵌套二",
    "2. 二",
    "",
    "| a | b |",
    "| :- | -: |",
    "| 1 | 2 |",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "> 引用",
    "",
    "---",
  ].join("\n");

  const blocks = parseMarkdown(src);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "list", "table", "code", "quote", "hr"],
  );

  const heading = blocks[0];
  assert.equal(heading.kind, "heading");
  if (heading.kind === "heading") {
    assert.equal(heading.depth, 2);
    assert.equal(inlineText(heading.children), "标题");
  }

  const list = blocks[1];
  assert.equal(list.kind, "list");
  if (list.kind === "list") {
    assert.equal(list.ordered, true);
    assert.equal(list.start, 1);
    assert.equal(list.items.length, 2);
    const nested = list.items[0].find((item) => item.kind === "list");
    assert.ok(nested, "第一项里应有嵌套列表");
    if (nested?.kind === "list") {
      assert.equal(nested.ordered, false);
      assert.equal(nested.items.length, 2);
    }
  }

  const table = blocks[2];
  assert.equal(table.kind, "table");
  if (table.kind === "table") {
    assert.deepEqual(table.align, ["left", "right"]);
    assert.equal(table.header.length, 2);
    assert.equal(table.rows.length, 1);
  }

  const code = blocks[3];
  assert.equal(code.kind, "code");
  if (code.kind === "code") {
    assert.equal(code.lang, "ts");
    assert.equal(code.text, "const a = 1;");
  }

  const quote = blocks[4];
  assert.equal(quote.kind, "quote");
  if (quote.kind === "quote") {
    assert.equal(quote.blocks.length, 1);
    assert.equal(blockText(quote), "引用");
  }
});

test("块级 HTML 与 script 降级成 paragraph 文本，不产生 html 块", () => {
  const blocks = parseMarkdown("<div>x</div>\n\n<script>alert(1)</script>");
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "paragraph"]);
  const text = blocks.map(blockText).join("\n");
  assert.ok(text.includes("<div>x</div>"));
  assert.ok(text.includes("<script>alert(1)</script>"));

  const inline = parseMarkdown("a <img src=x onerror=alert(1)> b");
  assert.equal(inline[0].kind, "paragraph");
  assert.ok(blockText(inline[0]).includes("<img src=x onerror=alert(1)>"));
});

test("链接只放行 http / https / mailto，其它 scheme 拍平成文本", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.com"]) {
    const blocks = parseMarkdown(`[x](${href})`);
    const paragraph = blocks[0];
    assert.equal(paragraph.kind, "paragraph");
    if (paragraph.kind !== "paragraph") continue;
    assert.equal(collectLinks(blockInlines(paragraph)).length, 0, `${href} 不应生成 link`);
    assert.equal(inlineText(paragraph.children), "x");
  }

  const allowed = parseMarkdown("[e](https://a.b)");
  const links = collectLinks(blockInlines(allowed[0]));
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://a.b");
  assert.equal(inlineText(links[0].children), "e");

  const upper = parseMarkdown("[e](MAILTO:A@B.C)");
  assert.equal(collectLinks(blockInlines(upper[0]))[0]?.href, "MAILTO:A@B.C");
});

test("图片降级成纯文本且不生成 link", () => {
  const blocks = parseMarkdown("![图](https://a/b.png)");
  const paragraph = blocks[0];
  assert.equal(paragraph.kind, "paragraph");
  if (paragraph.kind !== "paragraph") return;

  assert.equal(collectLinks(paragraph.children).length, 0);
  const text = inlineText(paragraph.children);
  assert.ok(text.includes("[图片]"));
  assert.ok(text.includes("图"));
  assert.ok(text.includes("https://a/b.png"));
});

test("流式半截输入不抛异常，块类型沿用 marked 的 lexer 结果", () => {
  const openFence = parseMarkdown("```ts\nconst x = 1;\n");
  assert.equal(openFence[0].kind, "code");
  if (openFence[0].kind === "code") assert.equal(openFence[0].lang, "ts");

  const halfTable = parseMarkdown("| a | b |\n| --- | --- |\n| 1 |\n");
  assert.equal(halfTable[0].kind, "table");

  const halfStrong = parseMarkdown("**粗");
  assert.equal(halfStrong[0].kind, "paragraph");
  if (halfStrong[0].kind === "paragraph") {
    assert.equal(inlineText(halfStrong[0].children), "**粗");
  }

  const halfLink = parseMarkdown("[链接](");
  assert.equal(halfLink[0].kind, "paragraph");
  if (halfLink[0].kind === "paragraph") {
    assert.equal(inlineText(halfLink[0].children), "[链接](");
  }
});

test("列表 start 归一，任务列表标 task 并在首条文本前加 ☐ / ☑", () => {
  const unordered = parseMarkdown("- a\n- b");
  assert.equal(unordered[0].kind, "list");
  if (unordered[0].kind === "list") assert.equal(unordered[0].start, 1);

  const ordered = parseMarkdown("3. a\n4. b");
  assert.equal(ordered[0].kind, "list");
  if (ordered[0].kind === "list") assert.equal(ordered[0].start, 3);

  const tasks = parseMarkdown("- [ ] todo\n- [x] done");
  const taskList = tasks[0];
  assert.equal(taskList.kind, "list");
  if (taskList.kind !== "list") return;
  assert.equal(taskList.task, true);
  const first = taskList.items[0][0];
  const second = taskList.items[1][0];
  assert.equal(first.kind, "paragraph");
  assert.equal(second.kind, "paragraph");
  if (first.kind === "paragraph") assert.ok(inlineText(first.children).startsWith("☐ "));
  if (second.kind === "paragraph") assert.ok(inlineText(second.children).startsWith("☑ "));
});

test("表格短行按表头列数补空数组，不丢已有内容", () => {
  const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| only |\n");
  const table = blocks[0];
  assert.equal(table.kind, "table");
  if (table.kind !== "table") return;

  assert.equal(table.header.length, 2);
  assert.equal(table.rows[0].length, 2);
  assert.equal(inlineText(table.rows[0][0]), "only");
  assert.deepEqual(table.rows[0][1], []);
});

test("空白输入不产生块", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown(" \n\t\n"), []);
});

test("2000 字输入的解析耗时只防病态回归", () => {
  const unit = "正文测试 **粗体** `code` [链接](https://a.b) 结束。\n\n";
  let src = "";
  while (src.length < 2_000) src += unit;
  src = src.slice(0, 2_000);
  assert.equal(src.length, 2_000);

  const coldStarted = performance.now();
  const blocks = parseMarkdown(src);
  const coldElapsed = performance.now() - coldStarted;

  for (let index = 0; index < 5; index += 1) parseMarkdown(src);
  const samples = Array.from({ length: 7 }, () => {
    const started = performance.now();
    parseMarkdown(src);
    return performance.now() - started;
  }).sort((a, b) => a - b);
  // 微基准取最小值判：中位数会被共享 runner 的调度抖动整段抬起来
  // （实测同一份代码：本机中位数 0.76ms，GitHub windows-latest 5.33ms，约 7 倍）
  const best = samples[0];
  const median = samples[Math.floor(samples.length / 2)];

  console.log(
    `[markdown] 2000 字 parseMarkdown 冷启动 ${coldElapsed.toFixed(3)}ms，` +
      `热态最小 ${best.toFixed(3)}ms / 中位数 ${median.toFixed(3)}ms`,
  );
  assert.ok(blocks.length > 0);
  // 这条只防「病态回归」（比如某次改动把复杂度弄成 O(n²)），不是性能指标本身：
  // 本机 0.76ms、CI 5.33ms 都远在 15ms 之下，而真出问题通常是几十上百毫秒。
  assert.ok(best <= 15, `2000 字解析耗时 ${best.toFixed(3)}ms（最小），超过 15ms 回归线`);
});

test("更新说明：缩进续行仍属同一个项目符号（v0.0.10 真实 notes 形状）", () => {
  const src = [
    "- **打开「添加项目」不再闪黑色终端窗口**。以前每打开一次会闪几下（要问 `gh` 三件事：版本、登录态、仓库列表），",
    "  现在这些后台调用都不会再弹窗口。",
    "- **不再误报「GitHub CLI 不可用」**。",
    "",
  ].join("\n");
  const blocks = parseMarkdown(src);
  assert.equal(blocks.length, 1);
  const list = blocks[0];
  assert.equal(list?.kind, "list");
  if (list?.kind !== "list") return;
  assert.equal(list.items.length, 2, "两条项目符号，缩进续行不另起一条");
  const first = list.items[0] ?? [];
  const para = first[0];
  assert.equal(para?.kind, "paragraph");
  if (para?.kind !== "paragraph") return;
  const text = inlineText(para.children);
  assert.match(text, /现在这些后台调用都不会再弹窗口/, "续行并入同一条");
  assert.match(text, /仓库列表）/, "反引号内容仍在");
});

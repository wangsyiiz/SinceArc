import assert from "node:assert/strict";
import test from "node:test";

import {
  getHighlightCacheStats,
  HIGHLIGHT_CACHE_LIMIT,
  highlightCode,
  resetHighlightCache,
} from "./highlight.ts";
import { MAX_HIGHLIGHT_LINES, prismHighlighter } from "./prism.ts";

test("ts 片段映射到 keyword / string / number / comment", () => {
  const spans = prismHighlighter.tokenize(
    'const answer: number = 42;\nconst name = "sincearc";\n// note here',
    "ts",
  );

  assert.ok(spans.some((span) => span.theme === "keyword" && span.text === "const"));
  assert.ok(spans.some((span) => span.theme === "string" && span.text.includes("sincearc")));
  assert.ok(spans.some((span) => span.theme === "number" && span.text === "42"));
  assert.ok(spans.some((span) => span.theme === "comment" && span.text === "// note here"));
});

test("别名 py/python 与 sh/bash 的结果一致", () => {
  const python = "def add(a, b):\n    # sum\n    return a + b";
  const shell = "echo \"hi\"\n# done";

  assert.deepEqual(
    prismHighlighter.tokenize(python, "py"),
    prismHighlighter.tokenize(python, "python"),
  );
  assert.deepEqual(
    prismHighlighter.tokenize(shell, "sh"),
    prismHighlighter.tokenize(shell, "bash"),
  );
});

test("未标注与未知语言都只返回一个 plain span，不抛错", () => {
  const code = "const answer = 42;";

  for (const lang of [null, "", "brainfuck"]) {
    const result = highlightCode(code, lang);
    assert.equal(result.highlighted, false);
    assert.equal(result.omittedLines, null);
    assert.deepEqual(result.spans, [{ text: code, theme: "plain" }]);
  }
});

test("501 行块降级为单个 plain span 并带上行数", () => {
  const code = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, index) => `line ${index}`).join(
    "\n",
  );

  const result = highlightCode(code, "ts");
  assert.equal(result.highlighted, false);
  assert.equal(result.omittedLines, 501);
  assert.deepEqual(result.spans, [{ text: code, theme: "plain" }]);
  assert.deepEqual(prismHighlighter.tokenize(code, "ts"), [{ text: code, theme: "plain" }]);
});

test("LRU：第二次同键命中，超过 200 条淘汰最旧", () => {
  resetHighlightCache();
  const code = "const value = 1;";

  highlightCode(code, "ts");
  assert.deepEqual(getHighlightCacheStats(), { hits: 0, misses: 1, size: 1 });

  highlightCode(code, "ts");
  assert.deepEqual(getHighlightCacheStats(), { hits: 1, misses: 1, size: 1 });

  resetHighlightCache();
  for (let index = 0; index < HIGHLIGHT_CACHE_LIMIT + 1; index += 1) {
    highlightCode(`const value${index} = ${index};`, "ts");
  }
  assert.equal(getHighlightCacheStats().size, HIGHLIGHT_CACHE_LIMIT);

  const before = getHighlightCacheStats();
  highlightCode("const value0 = 0;", "ts");
  const after = getHighlightCacheStats();
  assert.equal(after.misses, before.misses + 1);
  assert.equal(after.hits, before.hits);
});

test("空串、只有换行、超长单行都不崩且文本不丢", () => {
  for (const code of ["", "\n", "\r\n", "x".repeat(10_000)]) {
    const result = highlightCode(code, "ts");
    assert.equal(result.spans.map((span) => span.text).join(""), code);
  }
});

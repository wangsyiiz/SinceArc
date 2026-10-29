import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetHeightClassCache,
  estimateMessageHeight,
  MESSAGE_ESTIMATE_HEIGHT,
} from "./message-height.ts";

test("估算高度：纯文本 72", () => {
  assert.equal(estimateMessageHeight({ text: "普通一句话" }), MESSAGE_ESTIMATE_HEIGHT.text);
});

test("估算高度：含代码块 200", () => {
  const text = "说明\n\n```ts\nconst answer = 42;\n```";
  assert.equal(estimateMessageHeight({ text }), MESSAGE_ESTIMATE_HEIGHT.code);
});

test("估算高度：含表格 260", () => {
  const text = "| 名称 | 值 |\n| --- | --- |\n| a | 1 |";
  assert.equal(estimateMessageHeight({ text }), MESSAGE_ESTIMATE_HEIGHT.table);
});

test("估算高度：带图片或轨迹卡 240", () => {
  assert.equal(
    estimateMessageHeight({ text: "看图 ![截图](https://example.com/a.png)" }),
    MESSAGE_ESTIMATE_HEIGHT.imageOrTrace,
  );
  assert.equal(
    estimateMessageHeight({ text: "", blocks: [{ kind: "trace.card" }] }),
    MESSAGE_ESTIMATE_HEIGHT.imageOrTrace,
  );
});

test("有 id 时第二次估算不再读正文", () => {
  __resetHeightClassCache();
  let reads = 0;
  const message = {
    id: "same-id",
    get text() {
      reads += 1;
      return "```ts\nconst answer = 42;\n```";
    },
  };

  assert.equal(estimateMessageHeight(message), MESSAGE_ESTIMATE_HEIGHT.code);
  assert.equal(reads, 1);
  assert.equal(estimateMessageHeight(message), MESSAGE_ESTIMATE_HEIGHT.code);
  assert.equal(reads, 1);
});

test("没有 id 时不查也不写缓存", () => {
  __resetHeightClassCache();
  let reads = 0;
  const message = {
    get text() {
      reads += 1;
      return "普通一句话";
    },
  };

  assert.equal(estimateMessageHeight(message), MESSAGE_ESTIMATE_HEIGHT.text);
  assert.equal(estimateMessageHeight(message), MESSAGE_ESTIMATE_HEIGHT.text);
  assert.equal(reads, 2);
});

test("atomKind 优先于正文块语法", () => {
  __resetHeightClassCache();
  let reads = 0;
  const message = {
    id: "atom-wins",
    atomKind: "table",
    get text() {
      reads += 1;
      return "```ts\nconst answer = 42;\n```";
    },
  };

  assert.equal(estimateMessageHeight(message), MESSAGE_ESTIMATE_HEIGHT.table);
  assert.equal(reads, 0);
});

test("高度分类覆盖 text/code/table/media", () => {
  __resetHeightClassCache();
  assert.equal(
    estimateMessageHeight({ id: "class-text", text: "一句话" }),
    MESSAGE_ESTIMATE_HEIGHT.text,
  );
  assert.equal(
    estimateMessageHeight({ id: "class-code", text: "```\nx\n```" }),
    MESSAGE_ESTIMATE_HEIGHT.code,
  );
  assert.equal(
    estimateMessageHeight({ id: "class-table", text: "| a | b |\n| - | - |" }),
    MESSAGE_ESTIMATE_HEIGHT.table,
  );
  assert.equal(
    estimateMessageHeight({ id: "class-media", atomKind: "trace.card", text: "" }),
    MESSAGE_ESTIMATE_HEIGHT.imageOrTrace,
  );
});

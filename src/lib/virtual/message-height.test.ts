import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessageHeight, MESSAGE_ESTIMATE_HEIGHT } from "./message-height.ts";

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

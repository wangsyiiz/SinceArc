import assert from "node:assert/strict";
import test from "node:test";

import { stripHtmlComments } from "./pr-body.ts";

test("单行 HTML 注释剥掉", () => {
  assert.equal(stripHtmlComments("a<!-- x -->b"), "ab");
});

test("跨行 HTML 注释整段剥掉", () => {
  assert.equal(stripHtmlComments("a<!-- x\ny -->b"), "ab");
});

test("多个 HTML 注释全部剥掉", () => {
  assert.equal(stripHtmlComments("a<!-- x -->b<!-- y -->c"), "abc");
});

test("未闭合的注释残尾从 <!-- 吃到结尾", () => {
  assert.equal(stripHtmlComments("a<!-- x"), "a");
});

test("<! 但不是注释时保持原样", () => {
  assert.equal(stripHtmlComments("a <! do"), "a <! do");
});

test("剥注释不顺手清洗空白与换行", () => {
  assert.equal(stripHtmlComments("  a\n\n\tb  "), "  a\n\n\tb  ");
});

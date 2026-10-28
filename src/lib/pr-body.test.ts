import assert from "node:assert/strict";
import test from "node:test";

import { splitBodyLinks } from "./pr-body.ts";

test("普通文本原样保留，不拆段", () => {
  assert.deepEqual(splitBodyLinks("hello world"), [{ kind: "text", text: "hello world" }]);
});

test("http / https / mailto 成为链接，周围文本保留", () => {
  assert.deepEqual(splitBodyLinks("see https://example.com/a and mailto:a@b.c now"), [
    { kind: "text", text: "see " },
    { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
    { kind: "text", text: " and " },
    { kind: "link", text: "mailto:a@b.c", href: "mailto:a@b.c" },
    { kind: "text", text: " now" },
  ]);
});

test("句末标点留在文本里，不进 href", () => {
  assert.deepEqual(splitBodyLinks("go to https://example.com/x."), [
    { kind: "text", text: "go to " },
    { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
    { kind: "text", text: "." },
  ]);
});

test("白名单之外的 scheme 不变成链接", () => {
  assert.deepEqual(splitBodyLinks("javascript:alert(1) ftp://x/y"), [
    { kind: "text", text: "javascript:alert(1) ftp://x/y" },
  ]);
});

test("原文里的尖括号 <script> 只是文本", () => {
  assert.deepEqual(splitBodyLinks("<script>alert(1)</script>"), [
    { kind: "text", text: "<script>alert(1)</script>" },
  ]);
});

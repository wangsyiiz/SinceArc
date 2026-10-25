import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { KIND_SPECS, isChatKind, mergeRuleOf } from "./message-registry.ts";

const RUST = new URL("../../src-tauri/src/message_kind.rs", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

/** 从 Rust 注册表里抠出 kind → { chat, merge } —— 权威在 Rust，这份 TS 只是镜像。 */
function rustSpecs(): Map<string, { chat: boolean; merge: string }> {
  const text = readFileSync(RUST, "utf8");
  const body = text.slice(text.indexOf("const REGISTRY"), text.indexOf("pub fn registry"));
  const out = new Map<string, { chat: boolean; merge: string }>();
  for (const chunk of body.split("KindSpec {").slice(1)) {
    const variant = /kind:\s*MessageKind::(\w+)/.exec(chunk)?.[1];
    const chat = /chat:\s*(true|false)/.exec(chunk)?.[1];
    const merge = /merge:\s*MergeRule::(\w+)/.exec(chunk)?.[1];
    if (!variant || !chat || !merge) continue;
    const serde = new RegExp(`\\n\\s*(?:Self::)?${variant} => "([^"]+)"`).exec(text)?.[1];
    assert.ok(serde, `Rust 里找不到 ${variant} 的序列化值`);
    out.set(serde, { chat: chat === "true", merge: mergeMap(merge) });
  }
  return out;
}

function mergeMap(variant: string): string {
  return variant.toLowerCase();
}

test("TS 镜像与 Rust 注册表逐项一致", () => {
  const rust = rustSpecs();
  assert.ok(rust.size >= 14, `只从 Rust 源里读到 ${rust.size} 条，扫描本身有问题`);
  assert.deepEqual(
    Object.keys(KIND_SPECS).sort(),
    [...rust.keys()].sort(),
    "kind 集合不一致：加/删 kind 必须两边一起改",
  );
  for (const [kind, spec] of Object.entries(KIND_SPECS)) {
    assert.deepEqual(
      spec,
      rust.get(kind),
      `${kind} 的 chat/merge 与 Rust 注册表不一致`,
    );
  }
});

test("兜底：未登记的 kind 不进聊天区、按一块一原子处理", () => {
  assert.equal(isChatKind("future.thing"), false);
  assert.equal(mergeRuleOf("future.thing"), "none");
  assert.equal(isChatKind("thought"), false);
  assert.equal(mergeRuleOf("thought"), "stream");
});

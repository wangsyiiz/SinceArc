import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODE_THEMES,
  DEFAULT_CODE_THEME_ID,
  normalizeCodeThemeId,
  type TokenKind,
} from "./themes.ts";

const TOKEN_KINDS: readonly TokenKind[] = [
  "plain",
  "comment",
  "keyword",
  "string",
  "number",
  "literal",
  "function",
  "type",
  "operator",
  "punct",
];

test("每套主题都覆盖九档且色值合法", () => {
  assert.equal(CODE_THEMES.length, 5);
  for (const theme of CODE_THEMES) {
    assert.deepEqual(
      Object.keys(theme.colors).sort(),
      [...TOKEN_KINDS].sort(),
      `${theme.id} 档位不全`,
    );
    for (const kind of TOKEN_KINDS) {
      assert.match(theme.colors[kind], /^#[0-9a-f]{6}$/, `${theme.id}.${kind}`);
    }
    assert.match(theme.background, /^#[0-9a-f]{6}$/, `${theme.id}.background`);
  }
});

test("各主题的 background 互不相同且均合法", () => {
  const backgrounds = CODE_THEMES.map((theme) => theme.background);
  assert.equal(new Set(backgrounds).size, CODE_THEMES.length);
});

test("主题 id 与 label 唯一", () => {
  assert.equal(new Set(CODE_THEMES.map((theme) => theme.id)).size, CODE_THEMES.length);
  assert.equal(new Set(CODE_THEMES.map((theme) => theme.label)).size, CODE_THEMES.length);
});

test("normalizeCodeThemeId 非法值回落默认，合法值原样返回", () => {
  for (const value of [undefined, null, "", "nope", 123]) {
    assert.equal(normalizeCodeThemeId(value), DEFAULT_CODE_THEME_ID);
  }
  for (const theme of CODE_THEMES) {
    assert.equal(normalizeCodeThemeId(theme.id), theme.id);
  }
});

test("主题 id 与 Rust 端 CODE_THEME_IDS 完全一致（防两边漂移）", () => {
  const rust = readFileSync(new URL("../../../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const line = rust.split("\n").find((l) => l.includes("pub const CODE_THEME_IDS"));
  assert.ok(line, "Rust 里找不到 CODE_THEME_IDS");
  const rustIds = [...line.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...rustIds].sort(),
    CODE_THEMES.map((theme) => theme.id).sort(),
  );
});

test("每套主题在 styles.css 里都有变量块", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  for (const theme of CODE_THEMES) {
    assert.ok(css.includes(`[data-code-theme="${theme.id}"]`), `${theme.id} 缺 CSS 变量块`);
  }
});

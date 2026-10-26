import assert from "node:assert/strict";
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

test("四套主题都覆盖九档且色值合法", () => {
  assert.equal(CODE_THEMES.length, 4);
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

test("四套主题的 background 互不相同且均合法", () => {
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

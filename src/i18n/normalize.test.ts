import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LANGUAGE, isSupportedLanguage, normalizeLanguage } from "./normalize.ts";

test("zh 开头一律归到 zh-CN（含繁体，本轮只有一份中文）", () => {
  for (const tag of ["zh", "zh-CN", "zh-cn", "zh-TW", "zh-Hans", "zh-Hant-TW", "ZH", " zh_CN "]) {
    assert.equal(normalizeLanguage(tag), "zh-CN", tag);
  }
});

test("en 开头一律归到 en", () => {
  for (const tag of ["en", "en-US", "en-GB", "EN", "en_us"]) {
    assert.equal(normalizeLanguage(tag), "en", tag);
  }
});

test("枚举之外一律落到默认语言（兜底动作，不报错）", () => {
  for (const bad of ["", "   ", "fr-FR", "ja", "zhx", "english", null, undefined, 42, {}, []]) {
    assert.equal(normalizeLanguage(bad), DEFAULT_LANGUAGE, String(bad));
  }
});

test("默认语言是 en", () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
});

test("isSupportedLanguage 只认登记过的值（脏值判定用）", () => {
  assert.equal(isSupportedLanguage("zh-CN"), true);
  assert.equal(isSupportedLanguage("en"), true);
  assert.equal(isSupportedLanguage("zh-TW"), false, "zh-TW 归一化后才算支持，原值不算");
  assert.equal(isSupportedLanguage(""), false);
  assert.equal(isSupportedLanguage(null), false);
});

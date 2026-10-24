import test from "node:test";
import assert from "node:assert/strict";
import { agentBrand } from "./agent-brands.ts";

test("认得的 agent 都带真实 mark（24×24 path）", () => {
  for (const name of ["hermes2 · Claude Code", "claude", "codex", "openai", "gemini", "Qwen3", "opencode"]) {
    const brand = agentBrand(name);
    assert.ok(brand, `${name} 应该匹配到品牌`);
    if (/hermes/i.test(name) && !/claude|codex/i.test(name)) continue; // Nous 的 Hermes 没有官方 mark，会落字母牌
    assert.match(brand?.path ?? "", /^[Mm]/, `${name} 的 path 应该是一段 SVG 路径`);
    assert.ok((brand?.path ?? "").length > 20, `${name} 的 path 太短，像是占位`);
  }
});

test("不认识的 agent 不猜品牌", () => {
  assert.equal(agentBrand("测试agent"), null);
  assert.equal(agentBrand(""), null);
  assert.equal(agentBrand(null), null);
});

test("Hermes（Nous Research）没有官方图标，不编", () => {
  const brand = agentBrand("hermes · fedora");
  // 它可能匹配不到（落字母牌），也可能匹配到别家；两种情况都不允许出现「编出来的 path」
  if (brand) assert.notEqual(brand.label, "Nous Research");
});

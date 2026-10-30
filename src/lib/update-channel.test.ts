import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUpdateChannel } from "./update-channel.ts";

describe("normalizeUpdateChannel", () => {
  it("认得商店渠道，大小写和空白都不计较", () => {
    assert.equal(normalizeUpdateChannel("store"), "store");
    assert.equal(normalizeUpdateChannel("  STORE "), "store");
  });

  it("直装版原样", () => {
    assert.equal(normalizeUpdateChannel("direct"), "direct");
  });

  it("认不出来一律当直装版（老后端、空值、非字符串）", () => {
    for (const raw of [undefined, null, "", "  ", "msix", 42, {}, []]) {
      assert.equal(normalizeUpdateChannel(raw), "direct");
    }
  });
});

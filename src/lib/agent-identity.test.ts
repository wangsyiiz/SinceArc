import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentProfile } from "./agent-identity.ts";

const hermes = { id: "p-hermes", name: "hermes · fedora" };
const codex = { id: "p-codex", name: "codex" };
const profiles = [hermes, codex];

describe("resolveAgentProfile", () => {
  it("会话自己的连接优先于全局默认连接", () => {
    // 用户在 codex 会话里把默认连接停在 hermes —— 名字必须是 codex
    assert.equal(
      resolveAgentProfile({ sessionProfileId: "p-codex", profiles, fallback: hermes })?.name,
      "codex",
    );
  });

  it("会话没有 profileId（老数据）时退回全局默认", () => {
    assert.equal(
      resolveAgentProfile({ sessionProfileId: null, profiles, fallback: hermes })?.name,
      "hermes · fedora",
    );
    assert.equal(
      resolveAgentProfile({ sessionProfileId: "  ", profiles, fallback: hermes })?.name,
      "hermes · fedora",
    );
  });

  it("会话指向已删除的连接时也退回全局默认，不显示未知", () => {
    assert.equal(
      resolveAgentProfile({ sessionProfileId: "p-gone", profiles, fallback: codex })?.name,
      "codex",
    );
  });

  it("两边都没有就是 undefined，调用方自己决定占位文案", () => {
    assert.equal(
      resolveAgentProfile({ sessionProfileId: "p-gone", profiles: [], fallback: undefined }),
      undefined,
    );
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { capsRows } from "./caps-format.ts";
import type { AgentCaps } from "./ipc/types.gen/AgentCaps.ts";

const allOn: AgentCaps = {
  loadSession: true,
  promptImage: true,
  promptAudio: true,
  promptEmbeddedContext: true,
  sessionList: true,
  sessionDelete: true,
  sessionFork: true,
  sessionResume: true,
  sessionClose: true,
  mcpHttp: true,
  mcpSse: true,
  mcpAcp: true,
};

test("12 行分组顺序稳定", () => {
  const rows = capsRows(allOn);
  assert.equal(rows.length, 12);
  assert.deepEqual(
    rows.map((row) => row.key),
    [
      "promptImage",
      "promptAudio",
      "promptEmbeddedContext",
      "loadSession",
      "sessionList",
      "sessionDelete",
      "sessionFork",
      "sessionResume",
      "sessionClose",
      "mcpHttp",
      "mcpSse",
      "mcpAcp",
    ],
  );
  assert.deepEqual(
    [...new Set(rows.map((row) => row.group))],
    ["输入", "会话", "MCP"],
  );
  assert.ok(rows.every((row) => row.on));
});

test("null 输入返回空数组", () => {
  assert.deepEqual(capsRows(null), []);
});

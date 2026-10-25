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

test("MCP 三项未声明时显示「未声明」，已声明仍是 ✓", () => {
  const allOff: AgentCaps = {
    ...allOn,
    mcpHttp: false,
    mcpSse: false,
    mcpAcp: false,
  };
  const mcpOff = capsRows(allOff).filter((row) => row.group === "MCP");
  assert.deepEqual(
    mcpOff.map((row) => row.display),
    ["未声明", "未声明", "未声明"],
  );
  assert.ok(mcpOff.every((row) => !row.on));

  const mcpOn = capsRows(allOn).filter((row) => row.group === "MCP");
  assert.ok(mcpOn.every((row) => row.on && row.display === "✓"));
});

test("非 MCP 组的 false 仍保持原来的状态字", () => {
  const rows = capsRows({
    ...allOn,
    promptImage: false,
    loadSession: false,
  }).filter((row) => row.group !== "MCP");
  assert.deepEqual(
    rows.filter((row) => !row.on).map((row) => row.display),
    ["✗", "✗"],
  );
});

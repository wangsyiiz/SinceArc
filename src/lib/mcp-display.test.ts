import assert from "node:assert/strict";
import test from "node:test";

import type { AgentCaps } from "./ipc/types.gen/AgentCaps.ts";
import type { McpCatalogEntryDto } from "./ipc/types.gen/McpCatalogEntryDto.ts";
import type { McpServerDto } from "./ipc/types.gen/McpServerDto.ts";
import { describeServer, transportSupportNote } from "./mcp-display.ts";

function caps(overrides: Partial<AgentCaps> = {}): AgentCaps {
  return {
    loadSession: false,
    promptImage: false,
    promptAudio: false,
    promptEmbeddedContext: false,
    sessionList: false,
    sessionDelete: false,
    sessionFork: false,
    sessionResume: false,
    sessionClose: false,
    mcpHttp: false,
    mcpSse: false,
    mcpAcp: false,
    ...overrides,
  };
}

function entry(kind: string, server: Record<string, unknown>): McpCatalogEntryDto {
  return {
    name: String(server.name ?? "server"),
    kind,
    enabled: true,
    server: server as unknown as McpServerDto,
  };
}

test("stdio 展示 command 与 args", () => {
  const row = entry("stdio", {
    name: "fs",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: [],
  });
  assert.equal(describeServer(row), "npx -y @modelcontextprotocol/server-filesystem");
});

test("http 与 sse 展示 url", () => {
  assert.equal(
    describeServer(entry("http", { type: "http", name: "remote", url: "https://example.test/mcp", headers: [] })),
    "https://example.test/mcp",
  );
  assert.equal(
    describeServer(entry("sse", { type: "sse", name: "legacy", url: "https://example.test/sse", headers: [] })),
    "https://example.test/sse",
  );
});

test("长文本保留省略号标记", () => {
  const row = entry("http", {
    type: "http",
    name: "long",
    url: `https://example.test/${"a".repeat(80)}`,
    headers: [],
  });
  const text = describeServer(row, 24);
  assert.equal(text.length, 24);
  assert.ok(text.endsWith("…"));
});

test("能力标注只覆盖 http/sse，且没有握手快照时不猜", () => {
  const noTransport = caps();
  assert.equal(transportSupportNote("stdio", noTransport), null);
  assert.equal(transportSupportNote("http", noTransport), "agent 未声明支持");
  assert.equal(transportSupportNote("sse", noTransport), "agent 未声明支持");
  assert.equal(transportSupportNote("http", caps({ mcpHttp: true })), null);
  assert.equal(transportSupportNote("sse", caps({ mcpSse: true })), null);
  assert.equal(transportSupportNote("http", null), null);
});

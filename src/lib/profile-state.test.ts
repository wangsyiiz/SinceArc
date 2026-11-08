import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { disconnectedProfile } from "./profile-state.ts";
import type { AgentProfile } from "../types.ts";

function makeProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "p-1",
    name: "hermes · 本机",
    launch: "wsl",
    detail: "hermes · 本机 · ~/source",
    connected: true,
    agentName: "hermes 0.9.1",
    protocolVersion: 1,
    caps: null,
    capsAt: 1794000000,
    program: "hermes",
    args: ["acp"],
    cwd: "/home/jerry/source",
    defaultMcp: null,
    ssh: { host: "", port: 22, user: "", auth: "key" },
    ...over,
  };
}

test("断开只清三样：connected / agentName / protocolVersion", () => {
  const before = makeProfile();
  const after = disconnectedProfile(before);
  assert.equal(after.connected, false);
  assert.equal(after.agentName, null);
  assert.equal(after.protocolVersion, null);
  // 其它字段一个都不许动：连接配置不是连接状态
  assert.equal(after.id, before.id);
  assert.equal(after.detail, before.detail);
  assert.equal(after.capsAt, before.capsAt);
  assert.deepEqual(after.args, before.args);
});

test("不改原对象", () => {
  const before = makeProfile();
  disconnectedProfile(before);
  assert.equal(before.connected, true);
  assert.equal(before.agentName, "hermes 0.9.1");
});

/**
 * 真实事故（2026-11-08）：`conn.exited` 只清了会话映射，没把 profile.connected 改回 false，
 * 于是 agent 进程崩了之后标题栏一直显示「已连接」。这条守卫盯的是「断开的形状只有一处」：
 * 两条断开路径（显式断开 / 进程退出）都必须走 disconnectedProfile，不许再手写一份字段。
 */
test("断开形状只有一处：运行时路径里不许再手写 connected: false", () => {
  const root = new URL("../../src/", import.meta.url);
  const files = ["App.tsx", "hooks/useAgentConnect.ts", "hooks/useAcpEvents.ts"];
  const offenders = files.filter((file) => {
    const text = readFileSync(new URL(file, root), "utf8");
    return /connected:\s*false/.test(text);
  });
  assert.deepEqual(
    offenders,
    [],
    `这些运行时路径又在手写断开字段了（应改用 lib/profile-state 的 disconnectedProfile）：${offenders.join(", ")}`,
  );
});

test("进程退出那条路径必须把 profileId 交给调用方", () => {
  const text = readFileSync(new URL("hooks/useAcpEvents.ts", new URL("../../src/", import.meta.url)), "utf8");
  assert.match(
    text,
    /onDisconnect\?\.\(profileId\)/,
    "conn.exited 的 onDisconnect 必须带 profileId，否则调用方改不了那一行的连接状态",
  );
});

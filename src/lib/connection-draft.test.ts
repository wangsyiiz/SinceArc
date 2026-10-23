import assert from "node:assert/strict";
import test from "node:test";
import {
  canSaveConnection,
  createEmptyConnection,
  isProfileDirty,
  missingFields,
} from "./connection-draft.ts";
import type { AgentProfile } from "../types.ts";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { ...createEmptyConnection("p-test"), ...overrides };
}

test("新建草稿使用与入库默认值一致的启动配置", () => {
  const p = createEmptyConnection("p-draft");
  assert.equal(p.launch, "ssh");
  assert.equal(p.program, "hermes");
  assert.deepEqual(p.args, ["acp"]);
  assert.deepEqual(p.ssh, { host: "", port: 22, user: "", auth: "key" });
});

test("SSH 缺主机与用户名时按顺序报出", () => {
  const p = profile({ launch: "ssh", ssh: { host: "", port: 22, user: "", auth: "key" } });
  assert.deepEqual(missingFields(p), ["主机", "用户名"]);
});

test("WSL 没填发行版也放过", () => {
  const p = profile({ launch: "wsl", distro: "" });
  assert.deepEqual(missingFields(p), []);
});

test("空命令算缺字段", () => {
  const p = profile({ launch: "local", program: "   ", ssh: undefined });
  assert.deepEqual(missingFields(p), ["agent 命令"]);
});

test("canSave 先报缺字段，再报未探测", () => {
  const incomplete = profile({ ssh: { host: "", port: 22, user: "", auth: "key" } });
  assert.deepEqual(canSaveConnection(false, incomplete), {
    ok: false,
    reason: "还缺：主机、用户名",
  });

  const complete = profile({ ssh: { host: "h", port: 22, user: "u", auth: "key" } });
  assert.deepEqual(canSaveConnection(false, complete), {
    ok: false,
    reason: "先探测通过才能保存",
  });
  assert.deepEqual(canSaveConnection(true, complete), { ok: true });
});

test("可编辑字段变化算脏，连接状态变化不算", () => {
  const base = profile({ ssh: { host: "h", port: 22, user: "u", auth: "key" } });
  assert.equal(isProfileDirty(base, { ...base, connected: true, agentName: "hermes" }), false);
  assert.equal(isProfileDirty(base, { ...base, name: "另一个名字" }), true);
  assert.equal(
    isProfileDirty(base, {
      ...base,
      ssh: { host: "h", port: 22, user: "u2", auth: "key" },
    }),
    true,
  );
});

test("命令参数与审批模式变化也算脏", () => {
  const base = profile({ launch: "local", program: "hermes", args: ["acp"], ssh: undefined });
  assert.equal(isProfileDirty(base, { ...base, args: ["acp", "--debug"] }), true);
  assert.equal(isProfileDirty(base, { ...base, defaultMode: "ask" }), true);
});

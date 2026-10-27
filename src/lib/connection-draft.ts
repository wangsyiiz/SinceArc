import type { AgentProfile } from "@/types";

export type MissingConnectionField = "host" | "user" | "agentCommand";

export type ConnectionSaveGate =
  | { ok: true }
  | { ok: false; reason: "missing"; fields: MissingConnectionField[] }
  | { ok: false; reason: "probeRequired" };

/** 新建连接草稿的初始值；id 由调用方生成，保存前这个 id 不会进 store。 */
export function createEmptyConnection(id: string): AgentProfile {
  return {
    id,
    name: "",
    launch: "ssh",
    detail: "",
    connected: false,
    agentName: null,
    protocolVersion: null,
    caps: null,
    capsAt: null,
    program: "hermes",
    args: ["acp"],
    cwd: "",
    defaultMcp: null,
    ssh: { host: "", port: 22, user: "", auth: "key" },
  };
}

/** 必填字段清单。名字不在此列：空名由 profileLabel 派生。 */
export function missingFields(p: AgentProfile): MissingConnectionField[] {
  const missing: MissingConnectionField[] = [];
  if (p.launch === "ssh") {
    if (!(p.ssh?.host ?? "").trim()) missing.push("host");
    if (!(p.ssh?.user ?? "").trim()) missing.push("user");
  }
  // WSL 留空时 agentProbe 会用默认发行版，因此 distro 不算必填。
  if (!(p.program ?? "").trim()) missing.push("agentCommand");
  return missing;
}

export function canSaveConnection(
  probeOk: boolean,
  p: AgentProfile,
): ConnectionSaveGate {
  const missing = missingFields(p);
  if (missing.length > 0) return { ok: false, reason: "missing", fields: missing };
  if (!probeOk) return { ok: false, reason: "probeRequired" };
  return { ok: true };
}

/** 只比较用户可编辑的配置；连接状态、握手结果不是表单脏值。 */
export function isProfileDirty(a: AgentProfile, b: AgentProfile): boolean {
  const comparable = (p: AgentProfile) => ({
    name: p.name ?? "",
    launch: p.launch,
    program: p.program ?? "",
    args: p.args ?? [],
    cwd: p.cwd ?? "",
    distro: p.distro ?? "",
    shell: p.shell ?? "",
    defaultMode: p.defaultMode ?? null,
    defaultMcp: p.defaultMcp ?? null,
    ssh: p.ssh
      ? {
          host: p.ssh.host ?? "",
          port: p.ssh.port ?? 22,
          user: p.ssh.user ?? "",
          auth: p.ssh.auth ?? "key",
          keyPath: p.ssh.keyPath ?? "",
          password: p.ssh.password ?? "",
        }
      : null,
  });
  return JSON.stringify(comparable(a)) !== JSON.stringify(comparable(b));
}

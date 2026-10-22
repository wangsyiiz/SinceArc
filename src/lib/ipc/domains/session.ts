//! 会话域：连接配置、会话行、消息。

import type { ProfileDto, SessionRowDto, SessionUpsert, TraceTurnDto } from "../types";
import type { MessagePage } from "../types.gen/MessagePage";
import type { AgentProfile, SshAuth, SshConfig } from "@/types";
import { invokeCmd } from "../client";

export function toDto(p: AgentProfile) {
  return {
    id: p.id,
    name: p.name,
    launch: p.launch,
    program: p.program ?? "hermes",
    args: p.args ?? ["acp"],
    cwd: p.cwd ?? "",
    defaultMode: p.defaultMode ?? null,
    distro: p.distro ?? "fedora",
    shell: p.shell ?? "zsh",
    sshHost: p.ssh?.host,
    sshPort: p.ssh?.port ?? 22,
    sshUser: p.ssh?.user,
    sshAuth: p.ssh?.auth,
    sshKeyPath: p.ssh?.keyPath,
    sshPassword: p.ssh?.password,
  };
}

/** 库里的配置读回来：DTO 是扁平的，还原成界面用的 AgentProfile */

export function fromDto(d: ProfileDto): AgentProfile {
  const ssh: SshConfig | undefined =
    d.launch === "ssh" && d.sshHost
      ? {
          host: d.sshHost,
          port: d.sshPort ?? 22,
          user: d.sshUser ?? "",
          auth: (d.sshAuth as SshAuth) ?? "key",
          keyPath: d.sshKeyPath ?? undefined,
          // 密码不在库里，重连时需要重新填
          password: undefined,
        }
      : undefined;

  return {
    id: d.id,
    name: d.name,
    launch: d.launch as AgentProfile["launch"],
    detail:
      d.launch === "ssh"
        ? `${d.sshUser ?? "?"}@${d.sshHost ?? "?"}`
        : d.launch === "wsl"
          ? `${d.distro ?? "wsl"} · ${d.program}`
          : d.program,
    connected: false,
    cwd: d.cwd,
    defaultMode: d.defaultMode ?? null,
    program: d.program,
    args: d.args,
    distro: d.distro ?? undefined,
    shell: d.shell ?? undefined,
    ssh,
  };
}

/**
 * 出站事件信封（后端 `src-tauri/src/wire.rs`）。**只有一个通道**，
 * 前端按 `profileId` 分发给各连接的处理器 —— 连接数不再等于通道数。
 */

export function profilesLoad(): Promise<ProfileDto[]> {
  return invokeCmd<ProfileDto[]>("profiles_load", {});
}

/** 整表覆盖保存（后端会剥掉 SSH 密码，密码永不落盘） */

export function profilesSave(profiles: AgentProfile[]): Promise<void> {
  return invokeCmd<void>("profiles_save", { profiles: profiles.map(toDto) });
}

/** 探测结果：真跑一次 initialize，agent 自报的名字/版本 */

export function sessionsList(profileId?: string): Promise<SessionRowDto[]> {
  return invokeCmd<SessionRowDto[]>("sessions_list", { profileId: profileId ?? null });
}

export function sessionUpsert(row: SessionUpsert): Promise<void> {
  return invokeCmd<void>("session_upsert", { row });
}

export function sessionDelete(id: string): Promise<void> {
  return invokeCmd<void>("session_delete", { id });
}

/** 把 ACP 会话绑到某个 UI 会话上（一处绑定，之后按它归属事件） */

export function sessionBindAcp(id: string, acpSessionId: string): Promise<void> {
  return invokeCmd<void>("session_bind_acp", { id, acpSessionId });
}

export function messagesAppend(
  sessionId: string,
  messages: { id: string; role: string; kind?: string; payload: unknown }[],
): Promise<void> {
  return invokeCmd<void>("messages_append", { sessionId, messages });
}

export function messagesLoad(
  sessionId: string,
  opts?: { limit?: number; beforeSeq?: number },
): Promise<MessagePage> {
  return invokeCmd<MessagePage>("messages_load", {
    sessionId,
    limit: opts?.limit ?? null,
    beforeSeq: opts?.beforeSeq ?? null,
  });
}

/* ---------- session/update 的解析 ---------- */

/**
 * 轨迹视图：最近 N 轮的提问与活动。
 *
 * 后端聚合（含 tool_call 与增量更新的合并），前端只渲染 —— 业务计算不进界面（E6）。
 */
export function sessionTrace(sessionId: string, limit = 50): Promise<TraceTurnDto[]> {
  return invokeCmd("session_trace", { sessionId, limit });
}

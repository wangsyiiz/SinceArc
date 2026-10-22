//! ACP 域：连接、会话、模式、权限、探测。

import type { AcpEvent, ConnectOutcome, DiscoveryOutcome, ModeChoice, ModesSnapshot, ProbeOutcome, RespondOutcome, SessionInfo, SessionUpdate } from "../types";
import type { AgentProfile } from "@/types";
import { invokeCmd } from "../client";
import { toDto } from "./session";

export async function connectAgent(
  profile: AgentProfile,
  uiSessionId?: string,
): Promise<ConnectOutcome> {
  return invokeCmd<ConnectOutcome>("agent_connect", {
    profile: toDto(profile),
    uiSessionId,
  });
}

export function sessionNew(
  profileId: string,
  cwd: string,
  uiSessionId?: string,
): Promise<SessionInfo> {
  return invokeCmd<SessionInfo>("session_new", { profileId, cwd, uiSessionId });
}

/** 发一轮消息。立即返回：内容从事件流回来，不在这里等生成完。 */
/** 把某个已存会话 load 进已连接的进程（向群成员发消息前必须先做） */

export function sessionLoad(
  profileId: string,
  acpSessionId: string,
  cwd: string,
  uiSessionId?: string,
): Promise<ModesSnapshot | null> {
  return invokeCmd<ModesSnapshot | null>("session_load", {
    profileId,
    acpSessionId,
    cwd,
    uiSessionId,
  });
}

export function sessionPrompt(
  sessionId: string,
  text: string,
  uiSessionId?: string,
): Promise<void> {
  return invokeCmd<void>("session_prompt", { sessionId, text, uiSessionId });
}

/**
 * 回答 agent 发来的权限请求。
 *
 * `cancelled` 只表示用户中止了这一轮；有拒绝选项时应当回 `selected`，
 * 否则 agent 那边会把它当成「整轮被取消」而不是「这次操作被拒绝」。
 */

export function agentRespondRequest(
  profileId: string,
  id: number,
  outcome: RespondOutcome,
): Promise<void> {
  return invokeCmd<void>("agent_respond_request", { profileId, id, outcome });
}

/** 读回本机存的连接配置 */

export function agentProbe(p: AgentProfile): Promise<ProbeOutcome> {
  return invokeCmd<ProbeOutcome>("agent_probe", { profile: toDto(p) });
}

/* ---------- agent 发现（docs/discovery.md） ---------- */

export function agentDiscover(profiles: AgentProfile[] = []): Promise<DiscoveryOutcome> {
  // SSH 只扫用户已经存了连接配置的 host（规范 §3）：不去碰未知主机。
  // 扫的是配置，不是密码本身 —— 后端复用启动层的同一套认证。
  const sshProfiles = profiles.filter((p) => p.launch === "ssh").map(toDto);
  return invokeCmd<DiscoveryOutcome>("agent_discover", { sshProfiles });
}

/** 上一次扫描的结果（启动时先渲染，不必等扫描跑完） */

export function agentDiscoveryCached(): Promise<DiscoveryOutcome | null> {
  return invokeCmd<DiscoveryOutcome | null>("agent_discovery_cached", {});
}

/* ---------- 群聊成员（docs/group-chat.md） ---------- */

export function disconnectAgent(profileId: string): Promise<void> {
  return invokeCmd<void>("agent_disconnect", { profileId });
}

export function sessionApplyMode(
  profileId: string,
  acpSessionId: string,
  uiSessionId: string,
): Promise<ModeChoice> {
  return invokeCmd<ModeChoice>("session_apply_mode", { profileId, acpSessionId, uiSessionId });
}

export function sessionChooseMode(
  profileId: string,
  acpSessionId: string,
  uiSessionId: string,
  modeId: string | null,
): Promise<ModeChoice> {
  return invokeCmd<ModeChoice>("session_choose_mode", {
    profileId,
    acpSessionId,
    uiSessionId,
    modeId,
  });
}

export function listConnected(): Promise<string[]> {
  return invokeCmd<string[]>("agent_list_connected");
}

export function asSessionUpdate(e: AcpEvent): SessionUpdate | null {
  if (e.kind !== "notification" || e.method !== "session/update") return null;
  return (e.params as SessionUpdate) ?? null;
}

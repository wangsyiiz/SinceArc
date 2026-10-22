//! 群成员域：agent 身份与成员关系。

import type { AgentUser, AgentUserTestResult } from "../types";
import type { MentionResolution } from "../types.gen/MentionResolution";
import type { AgentProfile } from "@/types";
import { invokeCmd } from "../client";
import { toDto } from "./session";

export function agentUserTest(
  profile: AgentProfile,
  acpSessionId: string,
  cwd?: string,
): Promise<AgentUserTestResult> {
  return invokeCmd<AgentUserTestResult>("agent_user_test", {
    profile: toDto(profile),
    acpSessionId,
    cwd: cwd ?? null,
  });
}

export function agentUsersList(): Promise<AgentUser[]> {
  return invokeCmd<AgentUser[]>("agent_users_list", {});
}

export function agentUserSave(user: AgentUser): Promise<void> {
  return invokeCmd<void>("agent_user_save", { user });
}

export function agentUserDelete(id: string): Promise<void> {
  return invokeCmd<void>("agent_user_delete", { id });
}

export function sessionMembers(sessionId: string): Promise<AgentUser[]> {
  return invokeCmd<AgentUser[]>("session_members", { sessionId });
}

/** 解析原文里的 @：成员、连接、ACP 会话与 cwd 均由后端决定。 */
export function mentionResolve(sessionId: string, text: string): Promise<MentionResolution> {
  return invokeCmd<MentionResolution>("mention_resolve", { sessionId, text });
}

export function sessionMemberAdd(sessionId: string, userId: string): Promise<void> {
  return invokeCmd<void>("session_member_add", { sessionId, userId });
}

export function sessionMemberRemove(sessionId: string, userId: string): Promise<void> {
  return invokeCmd<void>("session_member_remove", { sessionId, userId });
}

/* ---------- 会话与消息 ---------- */

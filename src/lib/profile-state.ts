import type { AgentProfile } from "@/types";

/**
 * 「这一刻不算连着」的唯一形状。
 *
 * 两条路都要落到这同一份字段上：用户点「断开」（`useAgentConnect.disconnect`）与
 * agent 进程自己退出（`conn.exited`）。以前只有前者写，于是进程崩了之后标题栏的
 * 状态点仍然显示「已连接」，而这一会话其实已经没有 ACP 会话了。
 */
export function disconnectedProfile(profile: AgentProfile): AgentProfile {
  return { ...profile, connected: false, agentName: null, protocolVersion: null };
}

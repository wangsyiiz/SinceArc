import type { AgentCaps } from "@/lib/ipc/types";

export type DelegateCaps = "unknown" | "member_fork" | "task_only";

/** 档位只读握手快照，缺失不等于支持。 */
export function delegateTargetCaps(
  profile: { caps: AgentCaps | null } | undefined,
): DelegateCaps {
  if (!profile?.caps) return "unknown";
  return profile.caps.sessionFork ? "member_fork" : "task_only";
}

export function delegateCapsLabel(caps: DelegateCaps): string {
  if (caps === "member_fork") return "带 TA 的上下文";
  if (caps === "task_only") return "只带任务描述";
  return "档位未知";
}

export function delegateCapsNote(caps: DelegateCaps): string {
  if (caps === "member_fork") return "";
  if (caps === "task_only") return "子任务看不到本会话历史，只拿到这段文字";
  return "先连一次这个 agent 才知道能不能带上下文；按只带任务描述派";
}

/**
 * 为什么这一档没带上 TA 的上下文。落点②：档位要跟着产出一起说，不能只在出错时冒出来。
 * 后端四个成因分开报（orchestration.md §3），这里逐条翻成人话；fork 是正常态，不返回原因。
 */
export function delegateReasonNote(reason: string | null | undefined): string {
  switch (reason) {
    case "fork":
      return "";
    case "fork_unsupported":
      return "这个 agent 没报 fork 能力";
    case "fork_failed":
      return "fork 失败，已按只带任务描述重跑";
    case "caps_unknown":
      return "从没握手，不知道它支不支持";
    case "member_missing":
      return "这个成员还没有可 fork 的会话";
    default:
      return "";
  }
}

/** 档位 + 原因合成轨迹里那一行 detail（「只带任务描述 · 这个 agent 没报 fork 能力」）。 */
export function delegateCapsDetail(caps: DelegateCaps, reason?: string | null): string {
  const label = delegateCapsLabel(caps);
  if (caps === "member_fork") return label;
  const note = delegateReasonNote(reason);
  return note ? `${label} · ${note}` : label;
}

export function delegateErrorMessage(code: number, targetName: string): string {
  switch (code) {
    case 50700:
      return `${targetName} 不在这个群里`;
    case 50701:
      return "任务正文为空或太长（上限 8KB）";
    case 50702:
      return "子任务不能再派活";
    case 50703:
      return "同时最多 3 个在跑，等一个回来再派";
    case 50704:
      return "这个派活已经结束或不属于当前会话";
    case 50300:
      return `${targetName} 的连接没连上`;
    default:
      return `派活失败（${code}）`;
  }
}

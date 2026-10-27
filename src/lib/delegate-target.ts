import type { AgentCaps } from "@/lib/ipc/types";
import type { MessageKey } from "@/i18n/zh-CN";

export type DelegateCaps = "unknown" | "member_fork" | "task_only";

/** 档位只读握手快照，缺失不等于支持。 */
export function delegateTargetCaps(
  profile: { caps: AgentCaps | null } | undefined,
): DelegateCaps {
  if (!profile?.caps) return "unknown";
  return profile.caps.sessionFork ? "member_fork" : "task_only";
}

export function delegateCapsLabel(caps: DelegateCaps): MessageKey {
  if (caps === "member_fork") return "settings.memberDetail.delegateCaps.memberFork";
  if (caps === "task_only") return "settings.memberDetail.delegateCaps.taskOnly";
  return "settings.memberDetail.delegateCaps.unknown";
}

export function delegateCapsNote(caps: DelegateCaps): MessageKey | null {
  if (caps === "member_fork") return null;
  if (caps === "task_only") return "delegate.caps.note.taskOnly";
  return "delegate.caps.note.unknown";
}

/**
 * 为什么这一档没带上 TA 的上下文。落点②：档位要跟着产出一起说，不能只在出错时冒出来。
 * 后端四个成因分开报（orchestration.md §3），这里逐条翻成人话；fork 是正常态，不返回原因。
 */
export function delegateReasonNote(reason: string | null | undefined): MessageKey | null {
  switch (reason) {
    case "fork":
      return null;
    case "fork_unsupported":
      return "delegate.caps.reason.forkUnsupported";
    case "fork_failed":
      return "delegate.caps.reason.forkFailed";
    case "caps_unknown":
      return "delegate.caps.reason.capsUnknown";
    case "member_missing":
      return "delegate.caps.reason.memberMissing";
    default:
      return null;
  }
}

export interface DelegateCapsDetail {
  labelKey: MessageKey;
  reasonKey?: MessageKey;
}

/** 档位 + 原因交给渲染层用整句模板组装。 */
export function delegateCapsDetail(caps: DelegateCaps, reason?: string | null): DelegateCapsDetail {
  const labelKey = delegateCapsLabel(caps);
  if (caps === "member_fork") return { labelKey };
  const reasonKey = delegateReasonNote(reason);
  return reasonKey ? { labelKey, reasonKey } : { labelKey };
}

export interface DelegateError {
  key: MessageKey;
  params?: Record<string, string | number>;
}

export function delegateErrorMessage(code: number, targetName: string): DelegateError {
  switch (code) {
    case 50700:
      return { key: "delegate.error.notInGroup", params: { target: targetName } };
    case 50701:
      return { key: "delegate.error.taskEmpty" };
    case 50702:
      return { key: "delegate.error.nested" };
    case 50703:
      return { key: "delegate.error.limit" };
    case 50704:
      return { key: "delegate.error.ended" };
    case 50300:
      return { key: "delegate.error.connect", params: { target: targetName } };
    default:
      return { key: "delegate.error.generic", params: { code } };
  }
}

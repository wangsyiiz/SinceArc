import type { PermissionOption } from "@/types";

export type AutoApproveLevel = "off" | "edits";

/** 规范：编辑类含 delete/move，不含 execute/read/search。 */
export const EDIT_KINDS = ["edit", "delete", "move"] as const;

/** 只有明确的编辑类请求才放行；未知/缺失 kind 一律不猜。 */
export function shouldAutoApprove(
  level: AutoApproveLevel,
  kind: string | null | undefined,
): boolean {
  if (level !== "edits") return false;
  if (kind === null || kind === undefined) return false;
  return (EDIT_KINDS as readonly string[]).includes(kind);
}

/** 只在请求自带的 options 里挑，绝不构造 optionId。 */
export function pickAllowOption(
  options: readonly PermissionOption[] | null | undefined,
): PermissionOption | null {
  if (!Array.isArray(options)) return null;
  return options.find((option) => option.tone === "allow" || option.tone === "always") ?? null;
}

/** agent 档已经覆盖了审批时，客户端这道闸不再有意义。 */
export function autoApproveCovered(agentModeId: string | null | undefined): boolean {
  return agentModeId === "accept_edits" || agentModeId === "dont_ask";
}

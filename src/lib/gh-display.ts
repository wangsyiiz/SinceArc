import type { CapabilityDto } from "./ipc/types.gen/CapabilityDto.ts";

export type RunTone = "ok" | "warn" | "danger" | "unknown";

/** run 的状态色只认既有令牌：成功 ok、进行中 warn、失败 danger、未知 ink。 */
export function runTone(status: string, conclusion?: string): RunTone {
  const value = (conclusion || status).toLowerCase();
  if (value === "success") return "ok";
  if (["failure", "cancelled", "timed_out", "action_required"].includes(value)) {
    return "danger";
  }
  if (["in_progress", "queued", "requested", "waiting", "pending"].includes(value)) {
    return "warn";
  }
  return "unknown";
}

const TONE_DOT: Record<RunTone, string> = {
  ok: "bg-ok-1",
  warn: "bg-warn-1",
  danger: "bg-danger-1",
  unknown: "bg-ink-3",
};

export function runDotClass(status: string, conclusion?: string): string {
  return TONE_DOT[runTone(status, conclusion)];
}

export interface CapabilityMap {
  [action: string]: CapabilityDto;
}

export function capabilityMap(
  actions: readonly CapabilityDto[] | undefined,
): CapabilityMap {
  const map: CapabilityMap = {};
  for (const capability of actions ?? []) map[capability.action] = capability;
  return map;
}

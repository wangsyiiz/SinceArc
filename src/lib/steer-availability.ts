export interface SteerCommand {
  name: string;
}

export function hasSteerCommand(commands: readonly SteerCommand[] | null | undefined): boolean {
  return !!commands?.some((command) => command.name === "steer");
}

/** 插话门禁：agent 声明了 steer，且这一路正文确实带过 messageId。 */
export function canSteer(
  commands: readonly SteerCommand[] | null | undefined,
  sawBodyMessageId: boolean,
): boolean {
  return sawBodyMessageId && hasSteerCommand(commands);
}

/**
 * 插话入口的三态。
 *
 * `waiting` 是真实的中间态：agent 声明了 steer，但还没见过任何带 messageId 的正文 ——
 * 这时插话的回执和正文在协议层还分不开，所以先不给入口，但也**不能**说「不支持」。
 */
export type SteerGate = "off" | "waiting" | "on";

export function steerGate(
  commands: readonly SteerCommand[] | null | undefined,
  sawBodyMessageId: boolean,
): SteerGate {
  if (!hasSteerCommand(commands)) return "off";
  return sawBodyMessageId ? "on" : "waiting";
}

/** 入口不可用时的说明；可用或与插话无关时返回 null（不占位、不加 title）。 */
export function steerUnavailableReason(gate: SteerGate): string | null {
  if (gate === "off") return "这个 agent 不支持插话";
  if (gate === "waiting") return "正文出现后才能插话";
  return null;
}

export interface SteerCommand {
  name: string;
}

export function hasSteerCommand(commands: readonly SteerCommand[] | null | undefined): boolean {
  return !!commands?.some((command) => command.name === "steer");
}

/** 插话门禁：agent 声明了 steer，且本轮正文确实带过 messageId。 */
export function canSteer(
  commands: readonly SteerCommand[] | null | undefined,
  sawBodyMessageId: boolean,
): boolean {
  return sawBodyMessageId && hasSteerCommand(commands);
}

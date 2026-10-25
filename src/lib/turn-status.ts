/** turns 只有 running / waiting_approval / finished / failed；取消由 stopReason 表达。 */
export function isTurnCancelled(
  status: string | null | undefined,
  stopReason: string | null | undefined,
): boolean {
  return status === "finished" && stopReason === "cancelled";
}

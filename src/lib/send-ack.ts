export type SendTrace = {
  /** When the prompt was handed to the agent. Use one clock consistently. */
  startedAt: number;
  /** Whether this turn was already running when the user asked to send. */
  busyAtSend: boolean;
  /** Any body/thought/tool event arrived while waiting for the terminal event. */
  sawStream: boolean;
  stopReason: string | null;
  resolvedAt: number | null;
};

export const ABSORBED_SEND_THRESHOLD_MS = 400;

/**
 * A send is absorbed when it was requested during a running turn, came back
 * almost immediately with end_turn, and produced no observable work.
 */
export function isAbsorbedSend(
  trace: SendTrace,
  thresholdMs = ABSORBED_SEND_THRESHOLD_MS,
): boolean {
  return (
    trace.busyAtSend === true &&
    trace.resolvedAt !== null &&
    trace.resolvedAt - trace.startedAt <= thresholdMs &&
    trace.sawStream === false &&
    trace.stopReason === "end_turn"
  );
}

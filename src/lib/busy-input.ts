export const BUSY_INPUT_MODES = ["interrupt", "queue", "steer"] as const;

export type BusyInputMode = (typeof BUSY_INPUT_MODES)[number];

export const DEFAULT_BUSY_INPUT_MODE: BusyInputMode = "interrupt";

export function asBusyInputMode(value: unknown): BusyInputMode {
  return BUSY_INPUT_MODES.includes(value as BusyInputMode)
    ? (value as BusyInputMode)
    : DEFAULT_BUSY_INPUT_MODE;
}

export interface QueuedPrompt {
  id: string;
  text: string;
}

export function enqueuePrompt(
  queue: readonly QueuedPrompt[],
  prompt: QueuedPrompt,
): QueuedPrompt[] {
  return [...queue, prompt];
}

/** FIFO: the next item is the oldest one; never mutates the input. */
export function dequeuePrompt(queue: readonly QueuedPrompt[]): {
  next: QueuedPrompt | null;
  rest: QueuedPrompt[];
} {
  if (queue.length === 0) return { next: null, rest: [] };
  return { next: queue[0] ?? null, rest: queue.slice(1) };
}

export function queueCount(queue: readonly QueuedPrompt[]): number {
  return queue.length;
}

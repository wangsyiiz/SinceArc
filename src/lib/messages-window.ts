export const MESSAGE_WINDOW = 200;
export const MESSAGE_WINDOW_MAX = 250;
export const WINDOW_EDGE = 30;
export const RUNNING_TURN_PIN_TAIL = 60;

export interface WindowPlan {
  dropHead: number;
  dropTail: number;
}

const NO_TRIM: WindowPlan = { dropHead: 0, dropTail: 0 };

export type WindowDiag = (tag: string, text: string) => void;

/**
 * Rows that must survive a trim.
 *
 * Streaming rows and unsent bubbles are always kept. Rows belonging to a
 * running turn are only kept while they are near the tail: a stale running turn
 * deep in history must not pin the window boundary.
 */
export function pinIndexes(input: {
  count: number;
  streaming: readonly number[];
  undelivered: readonly number[];
  runningTurn: readonly number[];
  tailWindow?: number;
}): number[] {
  const {
    count,
    streaming,
    undelivered,
    runningTurn,
    tailWindow = RUNNING_TURN_PIN_TAIL,
  } = input;
  if (!Number.isInteger(count) || count <= 0) return [];
  const tail = Number.isFinite(tailWindow)
    ? Math.max(0, Math.floor(tailWindow))
    : RUNNING_TURN_PIN_TAIL;
  const runningFrom = count - tail;
  const pinned = new Set<number>();
  const add = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) return;
    pinned.add(index);
  };

  for (const index of streaming) add(index);
  for (const index of undelivered) add(index);
  for (const index of runningTurn) {
    if (index >= runningFrom) add(index);
  }

  return [...pinned].sort((left, right) => left - right);
}

/**
 * Decide how much of the in-memory message list to drop.
 *
 * The window only moves while the viewport is near an edge. With more than
 * MESSAGE_WINDOW_MAX rows it trims back to MESSAGE_WINDOW, which gives the
 * scroll path 50 rows of hysteresis before another trim can happen.
 */
export function planWindow(input: {
  count: number;
  firstVisible: number;
  lastVisible: number;
  pinned?: readonly number[];
  diag?: WindowDiag;
}): WindowPlan {
  const { count, firstVisible, lastVisible, pinned = [], diag } = input;
  if (count <= MESSAGE_WINDOW_MAX) return NO_TRIM;

  const topDistance = Math.max(0, firstVisible);
  const bottomDistance = Math.max(0, count - 1 - lastVisible);
  const nearTop = firstVisible <= WINDOW_EDGE;
  const nearBottom = lastVisible >= count - 1 - WINDOW_EDGE;
  if (!nearTop && !nearBottom) return NO_TRIM;

  // When both edges are in range, follow the edge that is farther away.
  // Equal distances fall back to the bottom action (trim the head).
  const trimHead = nearBottom && (!nearTop || bottomDistance >= topDistance);

  if (trimHead) {
    let dropHead = count - MESSAGE_WINDOW;
    const plannedHead = dropHead;
    const shrinkPins: number[] = [];
    for (const index of pinned) {
      if (!Number.isInteger(index) || index < 0 || index >= dropHead) continue;
      dropHead = Math.min(dropHead, index);
      shrinkPins.push(index);
    }
    if (shrinkPins.length > 0) {
      diag?.(
        "WINDOW-PIN-SHRINK",
        `plan=dropHead=${plannedHead},dropTail=0 -> dropHead=${dropHead},dropTail=0 pinned=[${shrinkPins.join(",")}]`,
      );
    }
    return dropHead > 0 ? { dropHead, dropTail: 0 } : NO_TRIM;
  }

  let dropTail = count - MESSAGE_WINDOW;
  const plannedTail = dropTail;
  const shrinkPins: number[] = [];
  for (const index of pinned) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const removedFrom = count - dropTail;
    if (index < removedFrom) continue;
    dropTail = Math.min(dropTail, count - index - 1);
    shrinkPins.push(index);
  }
  if (shrinkPins.length > 0) {
    diag?.(
      "WINDOW-PIN-SHRINK",
      `plan=dropHead=0,dropTail=${plannedTail} -> dropHead=0,dropTail=${dropTail} pinned=[${shrinkPins.join(",")}]`,
    );
  }
  return dropTail > 0 ? { dropHead: 0, dropTail } : NO_TRIM;
}

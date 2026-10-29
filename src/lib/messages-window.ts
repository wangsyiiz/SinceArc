export const MESSAGE_WINDOW = 200;
export const MESSAGE_WINDOW_MAX = 250;
export const WINDOW_EDGE = 30;

export interface WindowPlan {
  dropHead: number;
  dropTail: number;
}

const NO_TRIM: WindowPlan = { dropHead: 0, dropTail: 0 };

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
}): WindowPlan {
  const { count, firstVisible, lastVisible, pinned = [] } = input;
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
    for (const index of pinned) {
      if (!Number.isInteger(index) || index < 0 || index >= dropHead) continue;
      dropHead = Math.min(dropHead, index);
    }
    return dropHead > 0 ? { dropHead, dropTail: 0 } : NO_TRIM;
  }

  let dropTail = count - MESSAGE_WINDOW;
  for (const index of pinned) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const removedFrom = count - dropTail;
    if (index < removedFrom) continue;
    dropTail = Math.min(dropTail, count - index - 1);
  }
  return dropTail > 0 ? { dropHead: 0, dropTail } : NO_TRIM;
}

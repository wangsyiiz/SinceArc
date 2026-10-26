export interface HintState {
  open: boolean;
  pinned: boolean;
}

export type HintEvent =
  | { type: "open-request" }
  | { type: "close-request" }
  | { type: "toggle-pin" }
  | { type: "dismiss" };

export const INITIAL_HINT_STATE: HintState = { open: false, pinned: false };

/**
 * Hint 的 pin 状态机。Tooltip 仍负责 hover/focus 延迟，这里只决定一次开/关请求
 * 能不能真正落地：固定态忽略 pointerleave/blur 带来的关闭请求，直到显式 dismiss。
 */
export function hintReducer(state: HintState, event: HintEvent): HintState {
  switch (event.type) {
    case "open-request":
      return state.open ? state : { ...state, open: true };
    case "close-request":
      return state.pinned || !state.open ? state : { ...state, open: false };
    case "toggle-pin":
      return state.pinned
        ? { open: false, pinned: false }
        : { open: true, pinned: true };
    case "dismiss":
      return state.open || state.pinned ? INITIAL_HINT_STATE : state;
  }
}

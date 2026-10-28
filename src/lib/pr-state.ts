/** PR 视图态 → 文案 key（三种界面共用，避免各写一份字符串）。 */
import type { MessageKey } from "@/i18n/zh-CN";
import type { PrStateView } from "./ipc/types.gen/PrStateView.ts";

export const PR_STATE_LABEL: Record<PrStateView, MessageKey> = {
  open: "pr.state.open",
  draft: "pr.state.draft",
  merged: "pr.state.merged",
  closed: "pr.state.closed",
};

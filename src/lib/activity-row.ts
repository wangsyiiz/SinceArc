/**
 * running 活动行的视图模型（docs/desktop-ux.md §21.1）。
 *
 * 抽成纯函数是为了可测：`node --test` 不转 JSX，DOM 断言跑不起来；
 * 「同一时刻只有一个标签」「body 空白不留空行」「count = 1 不带 ×N」
 * 这三条都属于「肉眼看起来还行，实际多了一个元素」的错，只能靠用例盯。
 */
import type { Activity } from "@/types";
import type { MessageKey } from "@/i18n/zh-CN";
import { decodeI18nText } from "./i18n-text.ts";

export interface RowLock {
  title: string;
  count: number;
}

export interface ActivityRowView {
  /** 左侧标签 key：思考中 / 调用工具中，二选一。 */
  labelKey: MessageKey;
  /** 中·主行：`activity.title`。 */
  title: string;
  /** 主行后缀（仅有值时渲染）。 */
  detail: string | null;
  /** 中·次行：`activity.body` 首行；空白时为 null（元素不渲染）。 */
  bodyLine: string | null;
  /** 右侧锁：没有锁时为 null。 */
  lock: { tooltipKey: MessageKey; path: string; countText: string | null } | null;
}

export function firstNonBlankLine(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * 起轮时 `usePrompt` 把标题设成 `thinking.running` 的 marker；思考行左侧标签已经写着
 * 「思考中」，主行再显示一遍就是同一句话出现两次。真正的 `tool_call.title` 不受影响。
 */
function titleForRow(activity: Activity): string {
  if (activity.kind !== "thinking") return activity.title;
  return decodeI18nText(activity.title)?.key === "thinking.running" ? "" : activity.title;
}

export function activityRowView(
  activity: Activity,
  lock: RowLock | undefined,
): ActivityRowView {
  return {
    labelKey: activity.kind === "thinking" ? "thinking.running" : "thinking.toolRunning",
    title: titleForRow(activity),
    detail: activity.detail && activity.detail.trim() ? activity.detail : null,
    bodyLine: firstNonBlankLine(activity.body),
    lock: lock
      ? {
          tooltipKey: "thinking.lockTooltip",
          path: lock.title,
          countText: lock.count > 1 ? `×${lock.count}` : null,
        }
      : null,
  };
}

/** 从活动 id 还原 ACP 会话 id；不是 `act-stream-*` 时返回 null。 */
export function acpSessionIdOfActivity(id: string): string | null {
  return id.startsWith("act-stream-") ? id.slice("act-stream-".length) : null;
}

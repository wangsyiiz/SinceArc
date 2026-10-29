export type ReplyNotifyPlan = { sound: boolean; toast: boolean };

export type ReplyNotifyInput = {
  /** 设置里的「回复音效」开关 */
  soundEnabled: boolean;
  /** 设置里的「系统通知」开关 */
  toastEnabled: boolean;
  /** 窗口自身是否处于前台 */
  windowFocused: boolean;
  /** 当前激活会话是否就是刚结束的这一轮所属会话 */
  viewingSession: boolean;
  /** ACP 的停止原因：正常结束是 end_turn */
  stopReason: string | null;
  outcome: "ok" | "failed";
};

/** 多会话几乎同时结束时的合并窗口（毫秒）。 */
export const REPLY_NOTIFY_COALESCE_MS = 800;

/**
 * §31.2 的三分法：只有正常结束的一轮才通知；不需要打扰时两个通道都关掉。
 */
export function planReplyNotify(input: ReplyNotifyInput): ReplyNotifyPlan {
  if (input.outcome !== "ok" || input.stopReason !== "end_turn") {
    return { sound: false, toast: false };
  }
  if (input.windowFocused && input.viewingSession) {
    return { sound: false, toast: false };
  }
  if (input.windowFocused) {
    return { sound: input.soundEnabled, toast: false };
  }
  return { sound: input.soundEnabled, toast: input.toastEnabled };
}

const DEFAULT_SUMMARY_CHARS = 120;
const FENCE_LINE = /^\s*(```|~~~)/;
const LEADING_MARKER = /^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/;

/** 去掉首行里的常见 markdown 标记，保留人读得懂的文字。 */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<![\w*])\*([^*]+)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^_]+)_(?![\w_])/g, "$1")
    .replace(/~~(.*?)~~/g, "$1");
}

/**
 * 通知正文摘要：去掉 markdown 换行与代码围栏，取首行，截断到 maxChars（超了加 …）。
 *
 * 「首行」按视觉行算：空的、只有围栏的行跳过；行尾的硬换行标记也去掉。
 */
export function summarizeReply(text: string, maxChars = DEFAULT_SUMMARY_CHARS): string {
  if (maxChars <= 0) return "";

  let summary = "";
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE_LINE.test(raw)) continue;
    let line = raw.replace(/[ \t]+$/, "").replace(/\\$/, "").trim();
    if (!line) continue;
    line = stripInlineMarkdown(line.replace(LEADING_MARKER, "")).trim();
    if (!line) continue;
    summary = line;
    break;
  }

  const chars = Array.from(summary);
  if (chars.length <= maxChars) return summary;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

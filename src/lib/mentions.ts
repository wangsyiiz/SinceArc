/**
 * 群里 `@` 的解析（docs/group-chat.md §3）。
 *
 * 为什么不用 `/@([\w-]+)/` 这种字符集正则：**短名里可能有中文**。
 * JS 的 `\w` 只匹配 ASCII，所以 `@hermes-测试2` 会被截成 `@hermes-`，
 * 拿去查成员必然查不到 —— 表现为「@成员在输入框里好好的，一发送就说不在群里」。
 *
 * 改成「拿已知短名去文本里找」：命中位置最早者胜，同位置取更长者
 * （避免 `@hermes-测试2` 被 `@hermes-测试` 抢先匹配）。
 */

export interface MentionHit {
  handle: string;
  /** `@` 在整个字符串里的下标 */
  start: number;
}

/** 前后都要是边界：前面是行首或空白，后面不能紧跟字母/数字（避免 @a 命中 @ab） */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[\p{L}\p{N}_-]/u.test(ch);
}

export function findMention(text: string, handles: string[]): MentionHit | null {
  const lower = text.toLowerCase();
  let best: MentionHit | null = null;
  for (const handle of handles) {
    if (!handle) continue;
    const needle = `@${handle.toLowerCase()}`;
    let from = 0;
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const before = idx === 0 ? undefined : lower[idx - 1];
      const after = lower[idx + needle.length];
      // 前面是空白/行首；后面是边界（空白、标点、结尾都算）
      if ((before === undefined || /\s/.test(before)) && isBoundary(after)) {
        if (!best || idx < best.start || (idx === best.start && handle.length > best.handle.length)) {
          best = { handle, start: idx };
        }
        break;
      }
      from = idx + 1;
    }
  }
  return best;
}

/**
 * 用户敲了 `@` 但没对上任何成员时，取出它到底敲了什么 —— 用来把错误说准，
 * 而不是只回一句「不在群里」。
 */
export function mentionToken(text: string): string | null {
  const m = /(^|\s)@([^\s]+)/.exec(text);
  if (!m) return null;
  // 短名不能含空格，但可能紧贴标点（`@hermes-9，行吗`）：在第一个句读标点处截断。
  // 只截这一小组字符，不用通用「非字母数字」规则 —— 短名允许中文、连字符、下划线。
  const cut = m[2].split(/[，。、,.!?！？:：;；]/)[0];
  return cut.length > 0 ? cut : null;
}

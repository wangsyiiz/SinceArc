import type { Message } from "@/types";

/**
 * 历史合并：同 id 以后到的为准；已知 seq 的按 seq 升序；
 * 还没落库的流式/提示消息没有 seq，稳定地留在已知历史之后。
 *
 * 单独放这里是为了能脱离 React 跑单测（hooks 里 import 了 "@/lib/ipc"，
 * node 的类型剥离跑不动路径别名）。
 */
export function mergeMessages(
  base: Message[],
  incoming: Message[],
  seqs: Record<string, number>,
): Message[] {
  const order = new Map<string, number>();
  const byId = new Map<string, Message>();
  const add = (message: Message) => {
    if (!order.has(message.id)) order.set(message.id, order.size);
    byId.set(message.id, message);
  };
  base.forEach(add);
  incoming.forEach(add);

  const sorted = [...byId.values()].sort((a, b) => {
    const aSeq = seqs[a.id];
    const bSeq = seqs[b.id];
    const aKnown = typeof aSeq === "number";
    const bKnown = typeof bSeq === "number";
    if (aKnown && bKnown) return aSeq - bSeq;
    if (aKnown) return -1;
    if (bKnown) return 1;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });

  return collapsePrefixDuplicates(sorted);
}

/**
 * agent 正文的前缀下限：太短的重合（「好的」「继续」）不能当作同一条。
 * 取 40 是有意的 —— 一条 40 字以上的正文被另一条**严格以它开头**，只可能是同一条的两份。
 */
const PREFIX_MIN_CHARS = 40;

/**
 * 把「同一段回答被落了两遍」折叠成一条（docs/acp-turn-synthesis.md §9）。
 *
 * 断线（agent closed stdout）时，已收到的半截正文会被迟到流收口落一次；
 * 重连后 agent 重放/续写同一段回答，又落一条完整版。两条是**严格前缀**关系
 * （实测 15,068 → 17,248 字），界面上就是同一条回答出现两次。
 *
 * 比对的是「最近一条 agent 正文」而不是「相邻一条」：重放来的完整版可能落在用户下一条提问之后
 * （本例中间隔着一条用户消息和一条失败通知），只比相邻的会漏。
 * 合并时把完整版放在**先出现的那条的位置** —— 那条回答属于更早的那一轮。
 */
function collapsePrefixDuplicates(sorted: Message[]): Message[] {
  const out: Message[] = [];
  /** out 里 agent 正文的下标，供后面几条比对 */
  let lastAgentIndex: number | null = null;
  for (const message of sorted) {
    if (message.role === "player" && message.atomKind === "text.agent") {
      const prev = lastAgentIndex === null ? undefined : out[lastAgentIndex];
      if (
        prev &&
        prev.role === "player" &&
        prev.atomKind === "text.agent" &&
        prev.text.trim().length >= PREFIX_MIN_CHARS &&
        message.text.length > prev.text.length &&
        message.text.startsWith(prev.text)
      ) {
        out[lastAgentIndex as number] = message;
        continue;
      }
      out.push(message);
      lastAgentIndex = out.length - 1;
      continue;
    }
    out.push(message);
  }
  return out;
}

/**
 * 重放吸收（docs/acp-turn-synthesis.md §9 的 C）：`session/load` 之后 agent 会把**已有的回答**再发一遍。
 *
 * - `drop`：已累计的那部分还是"上一条回答的前缀" —— 纯重放，整段丢弃；
 * - `absorb`：已经越过上一条回答 —— 说明这是同一段的**续写**，只把多出来的尾巴接上去；
 * - `new`：和上一条没关系，按新消息处理。
 *
 * 只有「我们自己没发起这一轮」（不在飞）时才会用到它 —— 真回答一定在 promptStarted 之后。
 */
export type ReplayVerdict = "drop" | "absorb" | "new";

export function replayVerdict(prevText: string | null | undefined, accumulated: string): ReplayVerdict {
  if (!prevText || !accumulated) return "new";
  if (prevText.startsWith(accumulated)) return "drop";
  if (accumulated.startsWith(prevText)) return "absorb";
  return "new";
}

/** 已加载消息里最小的 seq —— 向前翻页的游标 */
export function minSeq(seqs: Record<string, number>): number | null {
  let oldest: number | null = null;
  for (const seq of Object.values(seqs)) {
    if (oldest === null || seq < oldest) oldest = seq;
  }
  return oldest;
}

/** 已加载消息里最大的 seq —— 向后回填的游标 */
export function maxSeq(seqs: Record<string, number>): number | null {
  let newest: number | null = null;
  for (const seq of Object.values(seqs)) {
    if (newest === null || seq > newest) newest = seq;
  }
  return newest;
}

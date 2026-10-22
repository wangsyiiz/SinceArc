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

  return [...byId.values()].sort((a, b) => {
    const aSeq = seqs[a.id];
    const bSeq = seqs[b.id];
    const aKnown = typeof aSeq === "number";
    const bKnown = typeof bSeq === "number";
    if (aKnown && bKnown) return aSeq - bSeq;
    if (aKnown) return -1;
    if (bKnown) return 1;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

/** 已加载消息里最小的 seq —— 向前翻页的游标 */
export function minSeq(seqs: Record<string, number>): number | null {
  let oldest: number | null = null;
  for (const seq of Object.values(seqs)) {
    if (oldest === null || seq < oldest) oldest = seq;
  }
  return oldest;
}

/**
 * 正文与轮的对齐：只认 `messages.turn_id`，不做任何时间推断。
 *
 * 当前无生产调用点：本文件先入库备用，面板改渲染需要所有者确认视觉后再接线。
 *
 * 由来：`docs/message-model.md` §7 ——「messages 无 turn_id，正文归不了轮，
 * 『上一轮』靠时间算」。时间只能说明「这两条东西挨得近」，说明不了「它们是一回事」；
 * 两条几乎同时发生的记录（插话、系统提示、并行的群成员回答）用时间归轮必然错，
 * 而且错得很像对的 —— 界面上少一条、多一条、串到隔壁轮，都看不出来。
 *
 * 老数据 `turn_id` 为 NULL（规格 §10.2 ③），因此这里**显式**留一个「未分轮」桶，
 * 不拿最近的轮去兜底。三种归属分开表达，界面上各自可解释：
 *
 *   byTurn      这一条属于这一轮（一一对齐）
 *   unassigned  没有轮（老数据、握手期提示、非轮次消息）→ 显示成「未分轮」
 *   orphaned    指向一轮，但该轮不在本次读取范围内（翻页/只读最近 N 轮）→ 显示成「轮不在视图内」
 *
 * 为什么不把 orphaned 并进 unassigned：两者的成因和处置完全不同 —— 前者是「数据老了」，
 * 后者是「视图没取到」。并进一个桶就等于把可查的问题变成不可查。
 */

/** 一轮的键：真 turn id，或 null（未分轮）。空串不算 id，见 `normaliseTurnId`。 */
export type TurnKey = string | null;

/** 能参与对齐的东西：只要求带一个可空的 turnId。 */
export interface TurnMember {
  /** 该条属于哪一轮；None/null 表示不属于任何轮 */
  turnId?: string | null;
}

export interface TurnAlignment<T> {
  /** turn_id → 该轮的正文条目（顺序已按 `orderOf` 定好） */
  byTurn: Map<string, T[]>;
  /** turn_id 为空的老消息：单独一组，永远不并入任何一轮 */
  unassigned: T[];
  /** turn_id 指向本次没读到的轮 */
  orphaned: { turnId: string; items: T[] }[];
}

/** 空白/纯空格与 NULL 同义 —— 写入侧的历史脏值不该在界面上变成「一轮叫 ' ' 的轮」。 */
export function normaliseTurnId(id: string | null | undefined): TurnKey {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface OrderOptions<T> {
  /**
   * 原有的次序字段（DB 消息的 `seq`）。
   * 没给就完全按入参顺序（流式抵达顺序）；给了则组内按它升序，缺值的稳定排在后面。
   */
  orderOf?: (item: T) => number | undefined;
}

function orderBucket<T>(items: T[], opts?: OrderOptions<T>): T[] {
  const order = opts?.orderOf;
  if (!order) return items;
  return items
    .map((item, index) => ({ item, index, key: order(item) }))
    .sort((a, b) => {
      if (a.key !== undefined && b.key !== undefined) return a.key - b.key || a.index - b.index;
      if (a.key !== undefined) return -1;
      if (b.key !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/**
 * 按 turn_id 把条目归到已有的轮上。
 *
 * `turnIds` 是「这次视图里有哪些轮」；不在其中的 turn_id 进 `orphaned`，不静默丢弃。
 */
export function alignToTurns<T extends TurnMember>(
  items: readonly T[],
  turnIds: readonly string[],
  opts?: OrderOptions<T>,
): TurnAlignment<T> {
  const known = new Set(turnIds);
  const byTurn = new Map<string, T[]>();
  for (const id of turnIds) {
    // 先把空轮建出来：一轮没有正文也是合法状态（例如只有轨迹没有消息），
    // 调用方遍历 byTurn 时不必再判 null。
    if (!byTurn.has(id)) byTurn.set(id, []);
  }

  const unassigned: T[] = [];
  const orphans = new Map<string, T[]>();

  for (const item of items) {
    const key = normaliseTurnId(item.turnId);
    if (key === null) {
      unassigned.push(item);
      continue;
    }
    if (!known.has(key)) {
      const bucket = orphans.get(key);
      if (bucket) bucket.push(item);
      else orphans.set(key, [item]);
      continue;
    }
    byTurn.get(key)!.push(item);
  }

  for (const [id, bucket] of byTurn) byTurn.set(id, orderBucket(bucket, opts));

  return {
    byTurn,
    unassigned: orderBucket(unassigned, opts),
    orphaned: [...orphans.entries()].map(([turnId, bucket]) => ({
      turnId,
      items: orderBucket(bucket, opts),
    })),
  };
}

/**
 * 一轮的提问正文：该轮下 `role === "user"` 的条目按顺序拼成一段。
 *
 * 轨迹面板那一行的正文现在就取 `turns.prompt`（提问那一刻的快照）；有了 turn_id 之后
 * 它两个来源必须给出同一段文字，所以这里做成纯函数，好让面板和测试用同一份口径。
 */
export function userTextOf(
  items: readonly (TurnMember & { role?: string | null; text?: string | null })[],
): string {
  return items
    .filter((item) => item.role === "user")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** 分组结果是否「一切都对上了」：没有未分轮、也没有轮外正文。 */
export function isFullyAligned<T>(alignment: TurnAlignment<T>): boolean {
  return alignment.unassigned.length === 0 && alignment.orphaned.length === 0;
}

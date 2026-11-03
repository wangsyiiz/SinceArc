/**
 * dashboard「最近活动」的归并：runs / PRs / releases 三份数据在前端合成一条时间线。
 *
 * 排序规则（docs/gh.md §10.2）：
 * - 时间倒序；
 * - 同一时间戳按 `run > pr > release`，避免同一秒的事件顺序抖动；
 * - 缺时间（草稿 release）的条目排在最后，但不丢。
 */

export type FeedItem =
  | {
      kind: "run";
      id: number;
      title: string;
      status: string;
      conclusion?: string;
      at: string;
      url: string;
    }
  | {
      kind: "pr";
      number: number;
      title: string;
      state: string;
      at: string;
      url: string;
    }
  | {
      kind: "release";
      tag: string;
      name: string;
      at: string;
      url: string;
    };

export interface FeedRunInput {
  id: number;
  title: string;
  status: string;
  conclusion?: string | null;
  createdAt: string;
  url: string;
}

export interface FeedPrInput {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  url: string;
}

export interface FeedReleaseInput {
  tagName: string;
  name: string;
  publishedAt?: string | null;
  url?: string;
}

interface RankedItem {
  item: FeedItem;
  time: number | null;
  rank: number;
  order: number;
}

const RANK = { run: 0, pr: 1, release: 2 } as const;

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function mergeActivity(
  input: {
    runs: readonly FeedRunInput[];
    prs: readonly FeedPrInput[];
    releases: readonly FeedReleaseInput[];
  },
  limit = 10,
): FeedItem[] {
  const ranked: RankedItem[] = [];
  let order = 0;

  for (const run of input.runs) {
    ranked.push({
      item: {
        kind: "run",
        id: run.id,
        title: run.title,
        status: run.status,
        ...(run.conclusion ? { conclusion: run.conclusion } : {}),
        at: run.createdAt,
        url: run.url,
      },
      time: timestamp(run.createdAt),
      rank: RANK.run,
      order: order++,
    });
  }

  for (const pr of input.prs) {
    ranked.push({
      item: {
        kind: "pr",
        number: pr.number,
        title: pr.title,
        state: pr.state,
        at: pr.updatedAt,
        url: pr.url,
      },
      time: timestamp(pr.updatedAt),
      rank: RANK.pr,
      order: order++,
    });
  }

  for (const release of input.releases) {
    ranked.push({
      item: {
        kind: "release",
        tag: release.tagName,
        name: release.name || release.tagName,
        at: release.publishedAt ?? "",
        url: release.url ?? "",
      },
      time: timestamp(release.publishedAt),
      rank: RANK.release,
      order: order++,
    });
  }

  ranked.sort((a, b) => {
    if (a.time === null && b.time === null) return a.order - b.order;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    if (a.time !== b.time) return b.time - a.time;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.order - b.order;
  });

  return ranked.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}

/**
 * 「添加项目」选择器的纯数据合流：库里的远端身份 + gh repo list 的结果。
 *
 * 主键是 `host/owner/name`（docs/gh.md §2.2）。同一个远端只出一行：
 * 库里有副本就是 `hasLocal`，库里没有副本是 `browseOnly`，
 * 只有 gh 列表里出现才是 `needsClone`。
 *
 * 不 import `@/` 别名，`node --test` 可直接跑。
 */
import type { GhRepoListingDto } from "./ipc/types.gen/GhRepoListingDto.ts";
import type { RepoDto } from "./ipc/types.gen/RepoDto.ts";

export type RepoRowState = "hasLocal" | "needsClone" | "browseOnly";

export interface RepoPickerRow {
  host: string;
  owner: string;
  name: string;
  state: RepoRowState;
  pinned: boolean;
  lastUsedAt: number | null;
  defaultBranch?: string | null;
  isPrivate?: boolean;
  /** hasLocal 时的副本路径。 */
  localPath?: string;
  source: "gh" | "local";
}

function identityKey(host: string | null | undefined, owner: string, name: string): string {
  return `${(host ?? "").trim().toLowerCase()}\u0000${owner}\u0000${name}`;
}

function repoIdentityKey(repo: RepoDto): string {
  return identityKey(repo.host, repo.owner, repo.name);
}

function listingIdentityKey(listing: GhRepoListingDto): string {
  return identityKey(listing.host, listing.owner, listing.name);
}

function stateOf(repo: RepoDto): RepoRowState {
  return repo.locals.length > 0 ? "hasLocal" : "browseOnly";
}

/**
 * 按 `host/owner/name` 合流。gh 列表的顺序保留在前面，库里独有的项目跟在后面；
 * 排序由 `sortRepoRows` 负责，这里只保证身份唯一。
 */
export function buildRepoRows(
  repos: RepoDto[],
  listings: GhRepoListingDto[],
): RepoPickerRow[] {
  const repoByKey = new Map<string, RepoDto>();
  for (const repo of repos) {
    const key = repoIdentityKey(repo);
    if (!repoByKey.has(key)) repoByKey.set(key, repo);
  }

  const rows: RepoPickerRow[] = [];
  const seen = new Set<string>();

  for (const listing of listings) {
    const key = listingIdentityKey(listing);
    if (seen.has(key)) continue;
    seen.add(key);

    const repo = repoByKey.get(key);
    if (repo) {
      rows.push({
        host: repo.host || listing.host || "",
        owner: repo.owner,
        name: repo.name,
        state: stateOf(repo),
        pinned: repo.pinned,
        lastUsedAt: repo.lastUsedAt,
        defaultBranch: repo.defaultBranch ?? listing.defaultBranch ?? null,
        isPrivate: listing.isPrivate,
        localPath: repo.locals[0]?.path,
        source: "gh",
      });
      continue;
    }

    rows.push({
      host: listing.host ?? "",
      owner: listing.owner,
      name: listing.name,
      state: "needsClone",
      pinned: false,
      lastUsedAt: null,
      defaultBranch: listing.defaultBranch ?? null,
      isPrivate: listing.isPrivate,
      source: "gh",
    });
  }

  for (const repo of repos) {
    const key = repoIdentityKey(repo);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      host: repo.host,
      owner: repo.owner,
      name: repo.name,
      state: stateOf(repo),
      pinned: repo.pinned,
      lastUsedAt: repo.lastUsedAt,
      defaultBranch: repo.defaultBranch,
      localPath: repo.locals[0]?.path,
      source: "local",
    });
  }

  return rows;
}

function compareName(a: RepoPickerRow, b: RepoPickerRow): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.owner < b.owner) return -1;
  if (a.owner > b.owner) return 1;
  return 0;
}

function compareRecent(a: RepoPickerRow, b: RepoPickerRow): number {
  if (a.lastUsedAt == null && b.lastUsedAt == null) return 0;
  if (a.lastUsedAt == null) return 1;
  if (b.lastUsedAt == null) return -1;
  return b.lastUsedAt - a.lastUsedAt;
}

/** pin 区 → 最近（lastUsedAt desc，null 最后）→ 其它按 name 升序。返回新数组。 */
export function sortRepoRows(rows: RepoPickerRow[]): RepoPickerRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    const recent = compareRecent(a, b);
    if (recent !== 0) return recent;

    // 两个都还没有使用记录时，才按名称给出稳定的「其它」区顺序。
    if (a.lastUsedAt == null && b.lastUsedAt == null) return compareName(a, b);
    return 0;
  });
}

/** 只生成给用户复制的命令，不执行；GHES 需要把 host 一起写进 slug。 */
export function repoCloneCommand(
  row: Pick<RepoPickerRow, "host" | "owner" | "name">,
): string {
  const slug =
    row.host && row.host.toLowerCase() !== "github.com"
      ? `${row.host}/${row.owner}/${row.name}`
      : `${row.owner}/${row.name}`;
  return `gh repo clone ${slug}`;
}

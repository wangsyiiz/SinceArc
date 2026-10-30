//! 项目域：远端身份与本地副本的落库读写。
//!
//! 命令名只允许出现在通信层；业务代码从 `@/lib/ipc` 取。

import type { RepoDto } from "../types.gen/RepoDto";
import type { RepoListDto } from "../types.gen/RepoListDto";
import { invokeCmd } from "../client";

/** 已落库的项目：pin / 最近使用 / 本地副本都来自同一份 rows。 */
export function reposList(): Promise<RepoListDto> {
  return invokeCmd<RepoListDto>("repos_list");
}

/** 本地目录：后端解析 `.git/config` 的 origin 后落库，同一路径重复添加幂等。 */
export function reposAddLocal(path: string): Promise<RepoDto> {
  return invokeCmd<RepoDto>("repos_add_local", { path });
}

/** 「只看不干」：只写远端身份，不创建本地副本。 */
export function reposAddRemote(
  host: string,
  owner: string,
  name: string,
  defaultBranch?: string | null,
): Promise<RepoDto> {
  return invokeCmd<RepoDto>("repos_add_remote", { host, owner, name, defaultBranch });
}

export function reposPin(repoId: string, pinned: boolean): Promise<void> {
  return invokeCmd<void>("repos_pin", { repoId, pinned });
}

export function reposRemoveLocal(path: string): Promise<void> {
  return invokeCmd<void>("repos_remove_local", { path });
}

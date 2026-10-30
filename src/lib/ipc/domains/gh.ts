//! gh 域：状态探测、仓库身份解析、PR 列表/详情/diff。
//!
//! 这些命令名只允许出现在 `src/lib/ipc/` 里（`layering.test.ts` 会扫）；
//! 业务代码只 import `@/lib/ipc`。参数形状与 Rust 命令层一一对应，
//! `repo` 一律是 `RepoRefDto`（camelCase，`host` 可缺省）。

import type { DiffPageDto } from "../types.gen/DiffPageDto";
import type { GhRepoListDto } from "../types.gen/GhRepoListDto";
import type { GhStatusDto } from "../types.gen/GhStatusDto";
import type { PrDetailDto } from "../types.gen/PrDetailDto";
import type { PrListDto } from "../types.gen/PrListDto";
import type { RepoRefDto } from "../types.gen/RepoRefDto";
import type { ViewerDto } from "../types.gen/ViewerDto";
import { invokeCmd } from "../client";

/**
 * gh 是否可用、是否已登录。`force` 绕过后端 30s 缓存 —— 用户点「重新检测」时用它，
 * 否则装好/登录后 30s 内还会看到旧的失败结果。
 */
export function ghStatus(force = false): Promise<GhStatusDto> {
  return invokeCmd<GhStatusDto>("gh_status", { force });
}

/** 当前 gh 登录身份；`force` 绕过 domain 的 1h 缓存。 */
export function ghViewer(force = false): Promise<ViewerDto> {
  return invokeCmd<ViewerDto>("gh_viewer", { force });
}

/** 从本地目录的 `.git/config` 解析 `{ host, owner, name }`；不调 gh、不联网。 */
export function ghRepoResolve(path: string): Promise<RepoRefDto> {
  return invokeCmd<RepoRefDto>("gh_repo_resolve", { path });
}

/** 「从 GitHub 添加」的仓库列表；owner 省略 = 当前账号及可访问组织。 */
export function ghReposList(
  owner?: string | null,
  limit?: number,
  force = false,
): Promise<GhRepoListDto> {
  return invokeCmd<GhRepoListDto>("gh_repos_list", { owner, limit, force });
}

/** PR 列表。`state` 缺省由后端取 `open`。 */
export function ghPrList(
  repo: RepoRefDto,
  state?: "open" | "closed" | "merged" | "all",
  force = false,
): Promise<PrListDto> {
  return invokeCmd<PrListDto>("gh_pr_list", { repo, stateFilter: state, force });
}

/** PR 详情：正文、统计、文件清单（正文是原始文本，前端只做纯文本渲染）。 */
export function ghPrDetail(
  repo: RepoRefDto,
  number: number,
  force = false,
): Promise<PrDetailDto> {
  return invokeCmd<PrDetailDto>("gh_pr_detail", { repo, number, force });
}

/** diff 分页：`page` 0 基，`pageSize` 1..=200；越界页返回空 `lines`。 */
export function ghPrDiff(
  repo: RepoRefDto,
  number: number,
  page = 0,
  pageSize = 200,
  force = false,
): Promise<DiffPageDto> {
  return invokeCmd<DiffPageDto>("gh_pr_diff", { repo, number, page, pageSize, force });
}

/**
 * 代码视图的三步状态机：`gh_status → gh_repo_resolve → gh_pr_list`（docs/gh.md §6）。
 *
 * 纯逻辑 + 注入的 API：不 import 任何 `@/` 别名，`node --test` 可以直接跑；
 * React 那一层（`hooks/useGhRepo.ts`）只负责把真实 IPC 塞进来与把 phase 交给 App。
 *
 * 三态必须各自可见：不可用停在安装指引、解析失败停在「不是仓库 / 没远端」、
 * 列表空才是「这个仓库没有 PR」—— 所以状态是显式的 `GhPhase`，不是 loading/error/data 三元组。
 */
import type { CmdError } from "./ipc/client.ts";
import type { GhStatusDto } from "./ipc/types.gen/GhStatusDto.ts";
import type { PrDto } from "./ipc/types.gen/PrDto.ts";
import type { RepoRefDto } from "./ipc/types.gen/RepoRefDto.ts";

export type GhPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "unavailable"; status: GhStatusDto }
  | { kind: "resolving" }
  | { kind: "resolveFailed"; error: CmdError }
  | { kind: "loading" }
  | { kind: "ready"; identity: RepoRefDto; prs: PrDto[] }
  | { kind: "failed"; error: CmdError };

/** 哪些 phase 已经有结论、切回来不该重跑。 */
export function isSettledPhase(phase: GhPhase | undefined): boolean {
  return (
    phase?.kind === "ready" ||
    phase?.kind === "unavailable" ||
    phase?.kind === "resolveFailed" ||
    phase?.kind === "failed"
  );
}

/** 推进中（要画骨架）的 phase；`idle` 不算，因为它还没开始。 */
export function isBusyPhase(phase: GhPhase | undefined): boolean {
  return phase?.kind === "checking" || phase?.kind === "resolving" || phase?.kind === "loading";
}

/** 状态机需要的最小 API；真实实现直接来自 `@/lib/ipc` 的 gh 域。 */
export interface GhRepoApi {
  status: (force: boolean) => Promise<GhStatusDto>;
  resolve: (path: string) => Promise<RepoRefDto>;
  list: (repo: RepoRefDto, state: "open" | "closed" | "merged" | "all", force: boolean) => Promise<{ items: PrDto[] }>;
}

/** 把任意 reject 归一成 `CmdError`（IPC 层已经归一过一次，这里兜底）。 */
export function toCmdError(e: unknown): CmdError {
  if (e && typeof e === "object" && "code" in e && "msg" in e) return e as CmdError;
  return { code: 50000, msg: e instanceof Error ? e.message : String(e) };
}

/**
 * 跑完整三步。`force` = 用户点「重新检测」（status 强制刷新）。
 * 返回最后一次 phase；无论成败都不抛。
 */
export async function runGhRepoFlow(
  api: GhRepoApi,
  repoPath: string,
  force: boolean,
  onPhase: (phase: GhPhase) => void,
  /** browseOnly 项目没有本地路径，身份直接来自 repos 表；有它就不必 resolve。 */
  identityOverride?: RepoRefDto,
): Promise<GhPhase> {
  const emit = (phase: GhPhase): GhPhase => {
    onPhase(phase);
    return phase;
  };

  emit({ kind: "checking" });
  let status: GhStatusDto;
  try {
    status = await api.status(force);
  } catch (e) {
    return emit({ kind: "failed", error: toCmdError(e) });
  }
  // 不可用就停在第二步之前：不再往下调（§6 第 1 步）。
  if (!status.available || !status.loggedIn) {
    return emit({ kind: "unavailable", status });
  }

  emit({ kind: "resolving" });
  let identity: RepoRefDto;
  if (identityOverride) {
    identity = identityOverride;
  } else {
    try {
      identity = await api.resolve(repoPath);
    } catch (e) {
      const error = toCmdError(e);
      // 只有身份解析失败（50717）走「不是仓库 / 没远端」这块；
      // 其它错误仍按通用失败呈现，不误导成仓库问题。
      return emit(error.code === 50717 ? { kind: "resolveFailed", error } : { kind: "failed", error });
    }
  }

  emit({ kind: "loading" });
  try {
    const list = await api.list(identity, "all", force);
    return emit({ kind: "ready", identity, prs: list.items });
  } catch (e) {
    return emit({ kind: "failed", error: toCmdError(e) });
  }
}

export type DiffPhase = "idle" | "loading" | "ready" | "failed";

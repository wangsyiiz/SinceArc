/**
 * `useGhRepo`：把 `lib/gh-repo-flow.ts` 的三步状态机接到真实 IPC 上。
 * browseOnly 项目没有本地路径，直接用库里的远端身份跳过 `gh_repo_resolve`。
 *
 * phase 表由 App 按 repoId 持有：切走再切回时已经有结论的仓库不重新闪骨架。
 * hook 只负责「首次进入 / 重新检测」时推进，并把列表结果回传给 App 供侧栏计数。
 */
import { useCallback, useEffect, useRef } from "react";
import type { PrDto } from "@/lib/ipc";
import type { RepoRefDto } from "@/lib/ipc";
import { ghPrList, ghRepoResolve, ghStatus } from "@/lib/ipc";
import {
  isSettledPhase,
  runGhRepoFlow,
  type GhPhase,
  type GhRepoApi,
} from "@/lib/gh-repo-flow";

export type { GhPhase, GhRepoApi };
export { isBusyPhase, isSettledPhase } from "@/lib/gh-repo-flow";

const API: GhRepoApi = {
  status: (force) => ghStatus(force),
  resolve: (path) => ghRepoResolve(path),
  list: (repo, state, force) => ghPrList(repo, state, force),
};

export interface UseGhRepoArgs {
  repoId: string | undefined;
  repoPath: string | undefined;
  /** browseOnly：没有本地路径，但库里已有远端身份。 */
  repoIdentity?: RepoRefDto;
  /** 只有代码视图真的打开时才推进；关掉后不发命令。 */
  enabled: boolean;
  phase: GhPhase | undefined;
  onPhase: (repoId: string, phase: GhPhase) => void;
  onPrs: (repoId: string, prs: PrDto[]) => void;
}

export function useGhRepo({ repoId, repoPath, repoIdentity, enabled, phase, onPhase, onPrs }: UseGhRepoArgs) {
  // 回调放 ref：App 每次渲染都新建闭包，直接进依赖会让 effect 反复重跑。
  const onPhaseRef = useRef(onPhase);
  const onPrsRef = useRef(onPrs);
  const phaseRef = useRef(phase);
  onPhaseRef.current = onPhase;
  onPrsRef.current = onPrs;
  phaseRef.current = phase;

  /** 并发推进去重：连点「重新检测」时只认最后一次。 */
  const runToken = useRef(0);

  const advance = useCallback(
    async (force: boolean) => {
      if (!repoId || (!repoPath && !repoIdentity)) return undefined;
      const token = ++runToken.current;
      const result = await runGhRepoFlow(
        API,
        repoPath ?? "",
        force,
        (next) => {
          if (token !== runToken.current) return;
          onPhaseRef.current(repoId, next);
          if (next.kind === "ready") onPrsRef.current(repoId, next.prs);
        },
        repoIdentity,
      );
      return token === runToken.current ? result : undefined;
    },
    [repoId, repoPath, repoIdentity],
  );

  useEffect(() => {
    if (!enabled || !repoId || (!repoPath && !repoIdentity)) return;
    // 已经有结论就不重跑：切走再切回不闪骨架。
    if (isSettledPhase(phaseRef.current)) return;
    void advance(false);
  }, [advance, enabled, repoId, repoPath, repoIdentity]);

  /** 「重新检测」：`gh_status(force)` 之后重跑 resolve + list。 */
  const redetect = useCallback(() => {
    void advance(true);
  }, [advance]);

  return { redetect };
}

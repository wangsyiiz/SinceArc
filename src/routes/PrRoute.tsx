import { PrView } from "@/components/PrView";
import type { DiffPhase } from "@/lib/gh-repo-flow";
import type { CmdError, DiffPageDto, PrDetailDto, RepoRefDto } from "@/lib/ipc";
import type { GithubRepo } from "@/types";

interface PrRouteProps {
  repo: GithubRepo;
  identity?: RepoRefDto;
  prNumber: number;
  detail?: PrDetailDto;
  detailError?: CmdError;
  diff?: DiffPageDto;
  diffPhase: DiffPhase;
  diffError?: CmdError;
  onDiffPage: (page: number) => void;
  onRetryDiff?: () => void;
  onRetryDetail?: () => void;
  onQuote: () => void;
  onOpenExternal: (url: string) => void;
}

export function PrRoute({
  repo,
  identity,
  prNumber,
  detail,
  detailError,
  diff,
  diffPhase,
  diffError,
  onDiffPage,
  onRetryDiff,
  onRetryDetail,
  onQuote,
  onOpenExternal,
}: PrRouteProps) {
  if (!identity) {
    // PR 标签先于仓库身份就绪（直接打开历史标签）：显示骨架，等三步回来再渲染。
    return (
      <div className="flex h-full flex-col">
        <header className="shrink-0 border-b border-line-1/60 px-4 py-3">
          <div className="mx-auto max-w-3xl font-mono text-body text-ink-3">#{prNumber}</div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3.5">
            <span className="h-3 w-2/3 animate-pulse rounded-control bg-surface-2" />
            <span className="h-3 w-full animate-pulse rounded-control bg-surface-2" />
            <span className="h-20 w-full animate-pulse rounded-control bg-surface-2" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <PrView
      repo={repo}
      identity={identity}
      prNumber={prNumber}
      detail={detail}
      detailError={detailError}
      diff={diff}
      diffPhase={diffPhase}
      diffError={diffError}
      onDiffPage={onDiffPage}
      onRetryDiff={onRetryDiff}
      onRetryDetail={onRetryDetail}
      onQuote={onQuote}
      onOpenExternal={onOpenExternal}
    />
  );
}

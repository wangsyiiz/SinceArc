import { RepoBrowser } from "@/components/RepoBrowser";
import type { GhPhase } from "@/lib/gh-repo-flow";
import type { PrDto } from "@/lib/ipc";
import type { GithubRepo } from "@/types";

interface RepoRouteProps {
  repo: GithubRepo;
  phase: GhPhase;
  onRedetect: () => void;
  onCopy: (text: string) => void;
  onChooseRepo: () => void;
  onOpenPr: (pr: PrDto) => void;
}

export function RepoRoute({
  repo,
  phase,
  onRedetect,
  onCopy,
  onChooseRepo,
  onOpenPr,
}: RepoRouteProps) {
  return (
    <RepoBrowser
      repo={repo}
      phase={phase}
      onRedetect={onRedetect}
      onCopy={onCopy}
      onChooseRepo={onChooseRepo}
      onOpenPr={onOpenPr}
    />
  );
}

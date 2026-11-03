import { RepoDashboard } from "@/components/RepoDashboard";
import { ActionsView } from "@/components/repo/ActionsView";
import { CodeView } from "@/components/repo/CodeView";
import { IssuesView } from "@/components/repo/IssuesView";
import { PullsView } from "@/components/repo/PullsView";
import { ReleasesView } from "@/components/repo/ReleasesView";
import {
  RepoChecking,
  RepoFailed,
  RepoHeader,
  RepoResolveFailed,
  RepoUnavailable,
} from "@/components/repo/RepoChrome";
import { SettingsView } from "@/components/repo/SettingsView";
import type { GhPhase } from "@/lib/gh-repo-flow";
import { isBusyPhase } from "@/lib/gh-repo-flow";
import type { PrDto } from "@/lib/ipc";
import { repoViewOf } from "@/lib/route";
import type { GithubRepo, RepoView } from "@/types";

export interface RepoRouteProps {
  repo: GithubRepo;
  phase: GhPhase;
  view?: string;
  onSelectView: (view: RepoView) => void;
  onRedetect: () => void;
  onCopy: (text: string) => void;
  onChooseRepo: () => void;
  onOpenPr: (pr: PrDto) => void;
}

export function RepoRoute({
  repo,
  phase,
  view,
  onSelectView,
  onRedetect,
  onCopy,
  onChooseRepo,
  onOpenPr,
}: RepoRouteProps) {
  const selected = repoViewOf(view);
  if (phase.kind === "ready") {
    if (selected === "dashboard") {
      return (
        <RepoDashboard
          repo={repo}
          identity={phase.identity}
          prs={phase.prs}
          onSelectView={onSelectView}
        />
      );
    }
    if (selected === "pulls") {
      return (
        <PullsView
          repo={repo}
          identity={phase.identity}
          prs={phase.prs}
          onOpenPr={onOpenPr}
          onSelectView={onSelectView}
        />
      );
    }
    if (selected === "issues") {
      return <IssuesView repo={repo} identity={phase.identity} onSelectView={onSelectView} />;
    }
    if (selected === "actions") {
      return <ActionsView repo={repo} identity={phase.identity} onSelectView={onSelectView} />;
    }
    if (selected === "releases") {
      return (
        <ReleasesView repo={repo} identity={phase.identity} onSelectView={onSelectView} />
      );
    }
    if (selected === "code") {
      return <CodeView repo={repo} identity={phase.identity} onSelectView={onSelectView} />;
    }
    return <SettingsView repo={repo} identity={phase.identity} onSelectView={onSelectView} />;
  }

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          {(phase.kind === "idle" || isBusyPhase(phase)) && <RepoChecking />}
          {phase.kind === "unavailable" && (
            <RepoUnavailable status={phase.status} onCopy={onCopy} onRedetect={onRedetect} />
          )}
          {phase.kind === "resolveFailed" && (
            <RepoResolveFailed
              path={repo.path}
              error={phase.error}
              onChooseRepo={onChooseRepo}
              onRedetect={onRedetect}
            />
          )}
          {phase.kind === "failed" && (
            <RepoFailed error={phase.error} onRedetect={onRedetect} />
          )}
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { PlayCircle, RefreshCw, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { currentLocale } from "@/i18n/locale";
import { capabilityMap, runDotClass } from "@/lib/gh-display";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  useRepoCapabilities,
  useRepoRuns,
  useRepoWorkflows,
} from "@/hooks/useRepoData";
import { BackToDashboard } from "./BackToDashboard";
import { RepoHeader, RepoLoadError } from "./RepoChrome";
import { WriteAction } from "./WriteAction";

interface ActionsViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  onSelectView: (view: RepoView) => void;
}

export function ActionsView({ repo, identity, onSelectView }: ActionsViewProps) {
  const { t } = useTranslation();
  const workflows = useRepoWorkflows(identity, true);
  const runs = useRepoRuns(identity, true, 30);
  const capabilities = useRepoCapabilities(identity, true);
  const caps = useMemo(() => capabilityMap(capabilities.data?.actions), [capabilities.data]);
  const workflowItems = workflows.data?.items ?? [];
  const runItems = runs.data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-3">
          <div>
            <BackToDashboard onBack={() => onSelectView("dashboard")} />
            <div className="mb-2 flex items-center gap-2">
              <PlayCircle className="size-3.5 text-ink-3" />
              <span className="text-micro uppercase tracking-wide text-ink-3">
                {t("repo.dash.actions.heading")}
              </span>
            </div>
          </div>

          <section>
            <div className="mb-2 flex items-center gap-2 text-micro uppercase tracking-wide text-ink-3">
              <Workflow className="size-3.5" />
              {t("repo.dash.actions.workflows")}
              {!workflows.loading && !workflows.error && (
                <span className="font-mono">{workflowItems.length}</span>
              )}
            </div>
            {workflows.loading ? (
              <div className="flex flex-col gap-2" role="status">
                <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
                <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              </div>
            ) : workflows.error ? (
              <RepoLoadError error={workflows.error} onRetry={() => workflows.reload(true)} />
            ) : workflowItems.length === 0 ? (
              <p className="rounded-control border border-dashed border-line-1/60 px-4 py-6 text-center text-caption text-ink-3">
                {t("repo.dash.actions.noWorkflows")}
              </p>
            ) : (
              workflowItems.map((workflow) => (
                <div
                  key={workflow.id}
                  className="mb-1 flex items-center gap-2 rounded-control border border-transparent px-2.5 py-2 hover:border-line-1/60 hover:bg-surface-2/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small text-ink-1">{workflow.name}</span>
                    <span className="block truncate font-mono text-micro text-ink-3">
                      {workflow.path}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-micro text-ink-3">
                    {workflow.state === "active"
                      ? t("repo.dash.actionState.active")
                      : t("repo.dash.actionState.disabled")}
                  </span>
                  <WriteAction
                    action="workflow_dispatch"
                    label={t("repo.dash.write.dispatch")}
                    capabilities={caps}
                  />
                </div>
              ))
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center gap-2 text-micro uppercase tracking-wide text-ink-3">
              <RefreshCw className="size-3.5" />
              {t("repo.dash.actions.runs")}
              {!runs.loading && !runs.error && (
                <span className="font-mono">{runItems.length}</span>
              )}
            </div>
            {runs.loading ? (
              <div className="flex flex-col gap-2" role="status">
                <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
                <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
                <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              </div>
            ) : runs.error ? (
              <RepoLoadError error={runs.error} onRetry={() => runs.reload(true)} />
            ) : runItems.length === 0 ? (
              <p className="rounded-control border border-dashed border-line-1/60 px-4 py-6 text-center text-caption text-ink-3">
                {t("repo.dash.actions.noRuns")}
              </p>
            ) : (
              runItems.map((run) => (
                <div
                  key={run.id}
                  className="mb-1 flex items-center gap-2 rounded-control border border-transparent px-2.5 py-2 hover:border-line-1/60 hover:bg-surface-2/50"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      runDotClass(run.status, run.conclusion),
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small leading-snug text-ink-1">
                      {run.title}
                    </span>
                    <span className="flex items-center gap-2 font-mono text-micro text-ink-3">
                      <span className="truncate">{run.workflowName ?? ""}</span>
                      {run.branch && <span className="truncate">{run.branch}</span>}
                      <span className="shrink-0">
                        {relativeTime(run.createdAt, currentLocale())}
                      </span>
                    </span>
                  </span>
                  <WriteAction
                    action="run_rerun"
                    label={t("repo.dash.write.rerun")}
                    capabilities={caps}
                  />
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

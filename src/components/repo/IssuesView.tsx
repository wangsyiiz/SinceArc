import { useMemo } from "react";
import { CircleDot, MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { currentLocale } from "@/i18n/locale";
import { capabilityMap } from "@/lib/gh-display";
import { relativeTime } from "@/lib/relative-time";
import { useRepoCapabilities, useRepoIssues } from "@/hooks/useRepoData";
import { BackToDashboard } from "./BackToDashboard";
import { RepoHeader, RepoLoadError } from "./RepoChrome";
import { WriteAction } from "./WriteAction";

interface IssuesViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  onSelectView: (view: RepoView) => void;
}

export function IssuesView({ repo, identity, onSelectView }: IssuesViewProps) {
  const { t } = useTranslation();
  const issues = useRepoIssues(identity, true);
  const capabilities = useRepoCapabilities(identity, true);
  const caps = useMemo(() => capabilityMap(capabilities.data?.actions), [capabilities.data]);
  const items = issues.data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <BackToDashboard onBack={() => onSelectView("dashboard")} />
          <div className="mb-2 flex items-center gap-2">
            <CircleDot className="size-3.5 text-ink-3" />
            <span className="text-micro uppercase tracking-wide text-ink-3">
              {t("repo.dash.issues.heading")}
            </span>
            {!issues.loading && !issues.error && (
              <span className="font-mono text-micro text-ink-3">{items.length}</span>
            )}
          </div>
          {issues.loading ? (
            <div className="flex flex-col gap-2 py-1" role="status">
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
            </div>
          ) : issues.error ? (
            <RepoLoadError error={issues.error} onRetry={() => issues.reload(true)} />
          ) : items.length === 0 ? (
            <div className="rounded-control border border-dashed border-line-1/60 px-4 py-12 text-center text-caption text-ink-3">
              {t("repo.dash.issues.empty")}
            </div>
          ) : (
            items.map((issue) => (
              <div
                key={issue.number}
                className="mb-1 flex items-start gap-2 rounded-control border border-transparent px-2.5 py-2 hover:border-line-1/60 hover:bg-surface-2/50"
              >
                <span
                  className={
                    issue.state === "open"
                      ? "mt-0.5 shrink-0 rounded-mark px-1 font-mono text-micro text-ok-1"
                      : "mt-0.5 shrink-0 rounded-mark px-1 font-mono text-micro text-ink-3"
                  }
                >
                  {t(
                    issue.state === "open"
                      ? "repo.dash.issues.state.open"
                      : "repo.dash.issues.state.closed",
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-small leading-snug text-ink-1">
                    <span className="mr-1.5 font-mono text-caption text-ink-3">
                      #{issue.number}
                    </span>
                    {issue.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-micro text-ink-3">
                    <span className="truncate">{issue.author.login}</span>
                    <span className="shrink-0">
                      {relativeTime(issue.updatedAt, currentLocale())}
                    </span>
                    {issue.labels.slice(0, 4).map((label) => (
                      <span
                        key={label}
                        className="rounded-mark bg-surface-2/60 px-1.5 py-0.5"
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <WriteAction
                    action="issue_comment"
                    label={t("repo.dash.write.comment")}
                    capabilities={caps}
                    icon={<MessageSquare className="size-3" />}
                  />
                  <WriteAction
                    action="issue_close"
                    label={t("repo.dash.write.close")}
                    capabilities={caps}
                  />
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

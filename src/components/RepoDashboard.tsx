import { useMemo, type ReactNode } from "react";
import {
  CircleDot,
  FolderTree,
  GitPullRequest,
  PlayCircle,
  Settings,
  Tag,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CmdError, PrDto, RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { mergeActivity, type FeedItem } from "@/lib/activity-feed";
import { currentLocale } from "@/i18n/locale";
import { errorTextOf } from "@/lib/errors";
import { runDotClass } from "@/lib/gh-display";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  useRepoReleases,
  useRepoRuns,
  useRepoSummary,
  useRepoWorkflows,
} from "@/hooks/useRepoData";
import { RepoHeader } from "./repo/RepoChrome";
import { Tooltip } from "./ui/Tooltip";

interface RepoDashboardProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  prs: PrDto[];
  onSelectView: (view: RepoView) => void;
}

function metricValue(value: ReactNode, loading: boolean, error: CmdError | undefined) {
  if (loading) {
    return <span className="inline-block h-5 w-8 animate-pulse rounded-mark bg-surface-2" />;
  }
  if (error) return <span className="text-ink-3">—</span>;
  return value ?? <span className="text-ink-3">—</span>;
}

function Metric({
  label,
  value,
  loading,
  error,
  className,
}: {
  label: string;
  value: ReactNode;
  loading: boolean;
  error?: CmdError;
  className?: string;
}) {
  const { t } = useTranslation();
  const content = metricValue(value, loading, error);
  return (
    <div
      className={cn(
        "rounded-card border border-line-1/60 bg-surface-1/40 px-3 py-2.5",
        className,
      )}
    >
      <div className="text-micro uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 font-mono text-title text-ink-1">
        {error ? (
          <Tooltip label={errorTextOf(error, t)}>
            <span tabIndex={0} className="cursor-help">
              {content}
            </span>
          </Tooltip>
        ) : (
          content
        )}
      </div>
    </div>
  );
}

function ActivityRow({
  item,
  onSelectView,
}: {
  item: FeedItem;
  onSelectView: (view: RepoView) => void;
}) {
  const { t } = useTranslation();
  const view: RepoView =
    item.kind === "run" ? "actions" : item.kind === "pr" ? "pulls" : "releases";
  const badge =
    item.kind === "run"
      ? t("repo.dash.activity.run")
      : item.kind === "pr"
        ? t("repo.dash.activity.pr")
        : t("repo.dash.activity.release");
  const title =
    item.kind === "pr"
      ? `#${item.number} ${item.title}`
      : item.kind === "release"
        ? `${item.name} · ${item.tag}`
        : item.title;
  const time = item.at
    ? relativeTime(item.at, currentLocale())
    : t("repo.dash.releases.unpublished");
  return (
    <button
      type="button"
      onClick={() => onSelectView(view)}
      className="flex w-full items-center gap-2 rounded-mark px-2 py-2 text-left transition-colors hover:bg-surface-2/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
    >
      <span
        className={cn(
          "shrink-0 rounded-mark px-1 font-mono text-micro",
          item.kind === "run" && "bg-accent-1/10 text-accent-1",
          item.kind === "pr" && "bg-ok-1/10 text-ok-1",
          item.kind === "release" && "bg-warn-1/10 text-warn-1",
        )}
      >
        {badge}
      </span>
      {item.kind === "run" && (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            runDotClass(item.status, item.conclusion),
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-small text-ink-1">{title}</span>
      <span className="shrink-0 font-mono text-micro text-ink-3">{time}</span>
    </button>
  );
}

export function RepoDashboard({ repo, identity, prs, onSelectView }: RepoDashboardProps) {
  const { t } = useTranslation();
  const summary = useRepoSummary(identity, true);
  const workflows = useRepoWorkflows(identity, true);
  const runs = useRepoRuns(identity, true, 10);
  const releases = useRepoReleases(identity, true, 3);

  const meta = summary.data?.meta.state === "ready" ? summary.data.meta.repo : undefined;
  const counts = summary.data?.counts;
  const countsReady = counts?.state === "ready";
  const metaError =
    summary.error ??
    (summary.data?.meta.state === "failed"
      ? (summary.data.meta.error as CmdError | undefined)
      : undefined);
  const countsError =
    summary.error ??
    (counts?.state === "failed" ? (counts.error as CmdError | undefined) : undefined);
  const workflowsError = workflows.error;
  const runsError = runs.error;
  const releasesError = releases.error;

  const latestRun = runs.data?.items[0];
  const latestRelease = meta?.latestRelease;
  const topics = meta?.topics ?? [];
  const visibleTopics = topics.slice(0, 6);
  const overflowTopics = topics.length - visibleTopics.length;
  /** 最近活动只取前 5 条 PR（后端按更新时间倒序），避免 PR 把 run/release 挤出前 10。 */
  const activityPrs = useMemo(() => prs.slice(0, 5), [prs]);

  const feed = useMemo(
    () =>
      mergeActivity(
        {
          runs: runs.data?.items ?? [],
          prs: activityPrs,
          releases: releases.data?.items ?? [],
        },
        10,
      ),
    [activityPrs, releases.data?.items, runs.data?.items],
  );
  const activityLoading = runs.loading && releases.loading && prs.length === 0;
  const activityError = runsError ?? releasesError;

  const entries: Array<{
    view: RepoView;
    icon: ReactNode;
    title: string;
    desc: string;
    value: ReactNode;
    loading: boolean;
    error?: CmdError;
  }> = [
    {
      view: "pulls",
      icon: <GitPullRequest className="size-3.5" />,
      title: t("repo.dash.entry.pulls.title"),
      desc: t("repo.dash.entry.pulls.desc"),
      value: countsReady ? (counts.openPrs ?? null) : null,
      loading: summary.loading,
      error: countsError,
    },
    {
      view: "issues",
      icon: <CircleDot className="size-3.5" />,
      title: t("repo.dash.entry.issues.title"),
      desc: t("repo.dash.entry.issues.desc"),
      value: countsReady ? (counts.openIssues ?? null) : null,
      loading: summary.loading,
      error: countsError,
    },
    {
      view: "actions",
      icon: <PlayCircle className="size-3.5" />,
      title: t("repo.dash.entry.actions.title"),
      desc: t("repo.dash.entry.actions.desc"),
      value: workflows.data?.items.length ?? null,
      loading: workflows.loading,
      error: workflowsError,
    },
    {
      view: "releases",
      icon: <Tag className="size-3.5" />,
      title: t("repo.dash.entry.releases.title"),
      desc: t("repo.dash.entry.releases.desc"),
      value: latestRelease?.tagName ?? null,
      loading: summary.loading,
      error: metaError,
    },
    {
      view: "code",
      icon: <FolderTree className="size-3.5" />,
      title: t("repo.dash.entry.code.title"),
      desc: t("repo.dash.entry.code.desc"),
      value: meta?.defaultBranch ?? null,
      loading: summary.loading,
      error: metaError,
    },
    {
      view: "settings",
      icon: <Settings className="size-3.5" />,
      title: t("repo.dash.entry.settings.title"),
      desc: t("repo.dash.entry.settings.desc"),
      value: meta?.visibility ?? null,
      loading: summary.loading,
      error: metaError,
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} meta={meta} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto sc-stream px-4 py-4">
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2.5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                <Metric
                  label={t("repo.dash.openPrs")}
                  value={countsReady ? (counts.openPrs ?? null) : null}
                  loading={summary.loading}
                  error={countsError}
                />
                <Metric
                  label={t("repo.dash.openIssues")}
                  value={countsReady ? (counts.openIssues ?? null) : null}
                  loading={summary.loading}
                  error={countsError}
                />
                <Metric
                  label={t("repo.dash.workflows")}
                  value={workflows.data?.items.length ?? null}
                  loading={workflows.loading}
                  error={workflowsError}
                />
                <Metric
                  label={t("repo.dash.latestRun")}
                  value={latestRun ? latestRun.conclusion ?? latestRun.status : null}
                  loading={runs.loading}
                  error={runsError}
                />
                <Metric
                  label={t("repo.dash.latestRelease")}
                  value={latestRelease?.tagName ?? null}
                  loading={summary.loading}
                  error={metaError}
                />
                <Metric
                  label={t("repo.dash.lastPush")}
                  value={meta?.pushedAt ? relativeTime(meta.pushedAt, currentLocale()) : null}
                  loading={summary.loading}
                  error={metaError}
                />
              </div>
              <div className="flex flex-col gap-1 px-1">
                <p className="truncate text-caption text-ink-2">
                  {summary.loading ? (
                    <span className="inline-block h-3 w-72 animate-pulse rounded-mark bg-surface-2" />
                  ) : meta ? (
                    meta.description || t("repo.dash.noDescription")
                  ) : (
                    ""
                  )}
                </p>
                {visibleTopics.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {visibleTopics.map((topic) => (
                      <span
                        key={topic}
                        className="rounded-mark bg-surface-2/60 px-1.5 py-0.5 font-mono text-micro text-ink-3"
                      >
                        {topic}
                      </span>
                    ))}
                    {overflowTopics > 0 && (
                      <span className="rounded-mark bg-surface-2/60 px-1.5 py-0.5 font-mono text-micro text-ink-3">
                        {t("repo.dash.topicsMore", { count: overflowTopics })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="mb-2 text-micro uppercase tracking-wide text-ink-3">
                {t("repo.dash.overview")}
              </div>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {entries.map((entry) => (
                  <button
                    key={entry.view}
                    type="button"
                    onClick={() => onSelectView(entry.view)}
                    className="flex min-h-20 flex-col items-start rounded-card border border-line-1/60 bg-surface-1/40 px-3 py-2.5 text-left transition-colors hover:border-line-1 hover:bg-surface-2/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                  >
                    <span className="flex items-center gap-1.5 text-small font-medium text-ink-1">
                      <span className="text-ink-3">{entry.icon}</span>
                      {entry.title}
                    </span>
                    <span className="mt-0.5 text-micro text-ink-3">{entry.desc}</span>
                    <span className="mt-auto self-end font-mono text-title text-ink-1">
                      {entry.error ? (
                        <Tooltip label={errorTextOf(entry.error, t)}>
                          <span tabIndex={0} className="cursor-help text-ink-3">
                            {metricValue(entry.value, entry.loading, entry.error)}
                          </span>
                        </Tooltip>
                      ) : (
                        metricValue(entry.value, entry.loading, entry.error)
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-1 text-micro uppercase tracking-wide text-ink-3">
                {t("repo.dash.activity")}
              </div>
              {feed.length > 0 ? (
                <div className="flex flex-col">
                  {feed.map((item, index) => (
                    <ActivityRow
                      key={`${item.kind}-${index}`}
                      item={item}
                      onSelectView={onSelectView}
                    />
                  ))}
                </div>
              ) : activityLoading ? (
                <div role="status" className="flex flex-col gap-2 py-2">
                  <span className="h-8 w-full animate-pulse rounded-control bg-surface-2" />
                  <span className="h-8 w-full animate-pulse rounded-control bg-surface-2" />
                </div>
              ) : activityError ? (
                <p className="px-2 py-3 text-caption text-danger-1">
                  {t("repo.dash.loadFailed", { msg: errorTextOf(activityError, t) })}
                </p>
              ) : (
                <p className="px-2 py-3 text-caption text-ink-3">{t("repo.dash.activityEmpty")}</p>
              )}
              {feed.length > 0 && activityError && (
                <p className="px-2 pt-1 text-micro text-ink-3">
                  {t("repo.dash.activityPartial", { msg: errorTextOf(activityError, t) })}
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

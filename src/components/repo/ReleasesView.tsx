import { Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { formatDateTime } from "@/lib/datetime";
import { useRepoReleases } from "@/hooks/useRepoData";
import { BackToDashboard } from "./BackToDashboard";
import { RepoHeader, RepoLoadError } from "./RepoChrome";

interface ReleasesViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  onSelectView: (view: RepoView) => void;
}

export function ReleasesView({ repo, identity, onSelectView }: ReleasesViewProps) {
  const { t } = useTranslation();
  const releases = useRepoReleases(identity, true, 50);
  const items = releases.data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <BackToDashboard onBack={() => onSelectView("dashboard")} />
          <div className="mb-2 flex items-center gap-2">
            <Tag className="size-3.5 text-ink-3" />
            <span className="text-micro uppercase tracking-wide text-ink-3">
              {t("repo.dash.releases.heading")}
            </span>
            {!releases.loading && !releases.error && (
              <span className="font-mono text-micro text-ink-3">{items.length}</span>
            )}
          </div>
          {releases.loading ? (
            <div className="flex flex-col gap-2 py-1" role="status">
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
            </div>
          ) : releases.error ? (
            <RepoLoadError error={releases.error} onRetry={() => releases.reload(true)} />
          ) : items.length === 0 ? (
            <div className="rounded-control border border-dashed border-line-1/60 px-4 py-12 text-center text-caption text-ink-3">
              {t("repo.dash.releases.empty")}
            </div>
          ) : (
            items.map((release) => (
              <div
                key={release.tagName}
                className="mb-1 flex items-start gap-2 rounded-control border border-transparent px-2.5 py-2 hover:border-line-1/60 hover:bg-surface-2/50"
              >
                <span className="mt-0.5 shrink-0 rounded-mark bg-surface-2/60 px-1.5 py-0.5 font-mono text-micro text-accent-1">
                  {release.tagName}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small leading-snug text-ink-1">
                    {release.name || release.tagName}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-micro text-ink-3">
                    {release.isLatest && (
                      <span className="rounded-mark bg-ok-1/10 px-1.5 py-0.5 text-ok-1">
                        {t("repo.dash.releases.latest")}
                      </span>
                    )}
                    {release.isDraft && (
                      <span className="rounded-mark bg-warn-1/10 px-1.5 py-0.5 text-warn-1">
                        {t("repo.dash.releases.draft")}
                      </span>
                    )}
                    {release.isPrerelease && (
                      <span className="rounded-mark bg-accent-1/10 px-1.5 py-0.5 text-accent-1">
                        {t("repo.dash.releases.prerelease")}
                      </span>
                    )}
                    <span>
                      {release.publishedAt
                        ? t("repo.dash.releases.publishedAt", {
                            at: formatDateTime(release.publishedAt),
                          })
                        : t("repo.dash.releases.unpublished")}
                    </span>
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

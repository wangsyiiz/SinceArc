import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CmdError, RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { errorTextOf } from "@/lib/errors";
import { useRepoSummary } from "@/hooks/useRepoData";
import { BackToDashboard } from "./BackToDashboard";
import { RepoHeader, RepoLoadError } from "./RepoChrome";

interface SettingsViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  onSelectView: (view: RepoView) => void;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-1/40 py-2 last:border-b-0">
      <span className="w-40 shrink-0 text-caption text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-small text-ink-1">{value}</span>
    </div>
  );
}

export function SettingsView({ repo, identity, onSelectView }: SettingsViewProps) {
  const { t } = useTranslation();
  const summary = useRepoSummary(identity, true);
  const meta = summary.data?.meta.state === "ready" ? summary.data.meta.repo : undefined;
  const metaError: CmdError | undefined =
    summary.error ??
    (summary.data?.meta.state === "failed"
      ? (summary.data.meta.error as CmdError | undefined)
      : undefined);

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} meta={meta} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <BackToDashboard onBack={() => onSelectView("dashboard")} />
          <div className="mb-2 flex items-center gap-2">
            <Settings className="size-3.5 text-ink-3" />
            <span className="text-micro uppercase tracking-wide text-ink-3">
              {t("repo.dash.settings.heading")}
            </span>
          </div>

          {summary.loading ? (
            <div className="flex flex-col gap-2 py-1" role="status">
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
            </div>
          ) : summary.error ? (
            <RepoLoadError error={summary.error} onRetry={() => summary.reload(true)} />
          ) : meta ? (
            <section className="rounded-control border border-line-1/60 bg-surface-1/40 px-3 py-1.5">
              <Field label={t("repo.dash.settings.visibility")} value={meta.visibility} />
              <Field label={t("repo.dash.settings.defaultBranch")} value={meta.defaultBranch} />
              <Field
                label={t("repo.dash.settings.archived")}
                value={meta.isArchived ? t("repo.dash.settings.yes") : t("repo.dash.settings.no")}
              />
              <Field
                label={t("repo.dash.settings.hasIssues")}
                value={meta.hasIssues ? t("repo.dash.settings.yes") : t("repo.dash.settings.no")}
              />
              <Field
                label={t("repo.dash.settings.latestRelease")}
                value={meta.latestRelease?.tagName ?? "—"}
              />
            </section>
          ) : (
            <div className="rounded-control border border-dashed border-danger-1/40 px-3 py-3">
              <p className="break-words text-caption text-danger-1">
                {t("repo.dash.settings.metaUnavailable")}
                {metaError ? ` · ${errorTextOf(metaError, t)}` : ""}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

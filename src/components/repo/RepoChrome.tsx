import { useEffect, useRef, useState } from "react";
import { Check, Copy, FolderGit2, RefreshCw, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  CmdError,
  GhStatusDto,
  RepoMetaDto,
  RepoRefDto,
} from "@/lib/ipc";
import type { GithubRepo } from "@/types";
import { errorTextOf } from "@/lib/errors";
import { localizeText } from "@/lib/i18n-text";
import { Button } from "../ui/Button";

const WINGET = "winget install --id GitHub.cli";
const SCOOP = "scoop install gh";
const AUTH = "gh auth login";

export function RepoHeader({
  repo,
  identity,
  meta,
}: {
  repo: GithubRepo;
  identity?: RepoRefDto;
  meta?: RepoMetaDto;
}) {
  const { t } = useTranslation();
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
      <FolderGit2 className="size-3.5 text-ink-2" />
      <span className="text-small font-medium text-ink-1">{localizeText(repo.name, t)}</span>
      <span className="truncate font-mono text-micro text-ink-3">
        {identity ? `${identity.owner}/${identity.name}` : repo.path || `${repo.owner}/${repo.name}`}
      </span>
      {meta && (
        <span className="flex shrink-0 items-center gap-1">
          <span className="rounded-mark bg-surface-3/45 px-1.5 py-0.5 font-mono text-micro uppercase text-ink-3">
            {meta.visibility}
          </span>
          <span className="rounded-mark bg-surface-3/45 px-1.5 py-0.5 font-mono text-micro text-ink-3">
            {meta.defaultBranch}
          </span>
          {meta.isArchived && (
            <span className="rounded-mark bg-surface-3/45 px-1.5 py-0.5 text-micro text-warn-1">
              {t("repo.dash.archived")}
            </span>
          )}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-micro text-ink-3">
        {identity?.host && (
          <span className="rounded-mark bg-surface-3/45 px-1.5 py-0.5">{identity.host}</span>
        )}
        <span className="max-w-60 truncate">
          {repo.path || (identity ? `${identity.owner}/${identity.name}` : "")}
        </span>
      </span>
    </header>
  );
}

/** 三步闸门各自的「在跑」共用一个骨架：灰条不是空状态文案。 */
export function RepoChecking() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t("repo.checking")} className="flex flex-col gap-2 py-1">
      <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
      <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
      <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
    </div>
  );
}

function CopyableCommand({
  command,
  onCopy,
}: {
  command: string;
  onCopy: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-mark bg-surface-2/60 px-2 py-1 font-mono text-caption text-ink-1">
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          onCopy(command);
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        }}
        className="flex shrink-0 items-center gap-1 rounded-mark px-1.5 py-1 text-micro text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
      >
        {copied ? <Check className="size-3 text-ok-1" /> : <Copy className="size-3" />}
        {copied ? t("repo.copied") : t("repo.copy")}
      </button>
    </div>
  );
}

export function RepoUnavailable({
  status,
  onCopy,
  onRedetect,
}: {
  status: GhStatusDto;
  onCopy: (text: string) => void;
  onRedetect: () => void;
}) {
  const { t } = useTranslation();
  const loggedOut = status.available && !status.loggedIn;

  return (
    <section className="rounded-control border border-line-1/60 bg-surface-1/40 px-4 py-4">
      <h2 className="text-small font-medium text-ink-1">
        {loggedOut ? t("repo.unavailableLoginTitle") : t("repo.unavailableTitle")}
      </h2>
      <div className="mt-3 flex flex-col gap-2.5 text-caption text-ink-2">
        {loggedOut ? (
          <div className="flex flex-col gap-1">
            <span>{t("repo.step2")}</span>
            <CopyableCommand command={AUTH} onCopy={onCopy} />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span>{t("repo.step1")}</span>
              <CopyableCommand command={WINGET} onCopy={onCopy} />
              <CopyableCommand command={SCOOP} onCopy={onCopy} />
            </div>
            <div className="flex flex-col gap-1">
              <span>{t("repo.step2")}</span>
              <CopyableCommand command={AUTH} onCopy={onCopy} />
            </div>
            <p className="text-ink-3">{t("repo.step3")}</p>
          </>
        )}
      </div>
      <div className="mt-3">
        <Button size="sm" variant="secondary" onClick={onRedetect}>
          <RefreshCw className="size-3" />
          {t("repo.redetect")}
        </Button>
      </div>
    </section>
  );
}

export function RepoResolveFailed({
  path,
  error,
  onChooseRepo,
  onRedetect,
}: {
  path: string;
  error: CmdError;
  onChooseRepo?: () => void;
  onRedetect: () => void;
}) {
  const { t } = useTranslation();
  const human =
    error.key === "err.gh.notGitRepo"
      ? t("repo.notGitRepo")
      : error.key === "err.gh.noRemote"
        ? t("repo.noRemote")
        : errorTextOf(error, t);

  return (
    <section className="rounded-control border border-dashed border-line-1/60 px-4 py-6">
      <h2 className="text-small font-medium text-ink-1">{human}</h2>
      <p className="mt-1.5 break-all font-mono text-micro text-ink-3">{path}</p>
      {error.key === "err.gh.noRemote" && error.params?.detail && (
        <p className="mt-1 break-all font-mono text-micro text-ink-3">{error.params.detail}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={onChooseRepo} disabled={!onChooseRepo}>
          <FolderGit2 className="size-3" />
          {t("repo.chooseDir")}
        </Button>
        <Button size="sm" variant="secondary" onClick={onRedetect}>
          <RefreshCw className="size-3" />
          {t("repo.redetect")}
        </Button>
      </div>
    </section>
  );
}

export function RepoFailed({
  error,
  onRedetect,
}: {
  error: CmdError;
  onRedetect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="rounded-control border border-dashed border-danger-1/40 px-4 py-6">
      <div className="flex items-start gap-2 text-caption text-danger-1">
        <Terminal className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{errorTextOf(error, t)}</span>
      </div>
      <div className="mt-3">
        <Button size="sm" variant="secondary" onClick={onRedetect}>
          <RefreshCw className="size-3" />
          {t("repo.retry")}
        </Button>
      </div>
    </section>
  );
}

export function RepoLoadError({
  error,
  onRetry,
}: {
  error: CmdError;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-control border border-dashed border-danger-1/40 px-3 py-3">
      <p className="break-words text-caption text-danger-1">
        {t("repo.dash.loadFailed", { msg: errorTextOf(error, t) })}
      </p>
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          {t("repo.retry")}
        </Button>
      )}
    </div>
  );
}

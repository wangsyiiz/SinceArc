import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  FolderGit2,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CmdError, GhStatusDto, PrDto } from "@/lib/ipc";
import type { GithubRepo } from "@/types";
import { cn } from "@/lib/utils";
import { localizeText } from "@/lib/i18n-text";
import { errorTextOf } from "@/lib/errors";
import { formatDateTime } from "@/lib/datetime";
import { PR_STATE_LABEL } from "@/lib/pr-state";
import { isBusyPhase, type GhPhase } from "@/lib/gh-repo-flow";
import { Button } from "./ui/Button";

const STATE_STYLE: Record<PrDto["state"], string> = {
  open: "text-ok-1",
  draft: "text-ink-3",
  merged: "text-warn-1",
  closed: "text-danger-1",
};

const CHECKS = {
  passing: { icon: CheckCircle2, className: "text-ok-1" },
  failing: { icon: XCircle, className: "text-danger-1" },
  pending: { icon: Loader2, className: "text-warn-1 animate-spin" },
} as const;

const WINGET = "winget install --id GitHub.cli";
const SCOOP = "scoop install gh";
const AUTH = "gh auth login";

interface RepoBrowserProps {
  repo: GithubRepo;
  phase: GhPhase;
  onRedetect: () => void;
  onCopy: (text: string) => void;
  onOpenPr: (pr: PrDto) => void;
  onChooseRepo?: () => void;
}

export function RepoBrowser({
  repo,
  phase,
  onRedetect,
  onCopy,
  onOpenPr,
  onChooseRepo,
}: RepoBrowserProps) {
  const { t } = useTranslation();
  const identity = phase.kind === "ready" ? phase.identity : undefined;
  const prs = phase.kind === "ready" ? phase.prs : [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
        <FolderGit2 className="size-3.5 text-ink-2" />
        <span className="text-small font-medium text-ink-1">{localizeText(repo.name, t)}</span>
        <span className="truncate font-mono text-micro text-ink-3">
          {identity ? `${identity.owner}/${identity.name}` : repo.path}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-micro text-ink-3">
          {identity?.host && (
            <span className="rounded-mark bg-surface-3/45 px-1.5 py-0.5">{identity.host}</span>
          )}
          <span className="max-w-60 truncate">{repo.path}</span>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          {(phase.kind === "idle" || isBusyPhase(phase)) && <Skeleton />}
          {phase.kind === "unavailable" && (
            <UnavailablePanel status={phase.status} onCopy={onCopy} onRedetect={onRedetect} />
          )}
          {phase.kind === "resolveFailed" && (
            <ResolveFailedPanel
              path={repo.path}
              error={phase.error}
              onChooseRepo={onChooseRepo}
              onRedetect={onRedetect}
            />
          )}
          {phase.kind === "failed" && (
            <FailedPanel error={phase.error} onRedetect={onRedetect} />
          )}
          {phase.kind === "ready" && (
            <>
              <div className="mb-2 flex items-center gap-2 text-micro tracking-wide text-ink-3">
                <span>PULL REQUESTS</span>
                <span className="font-mono">{prs.length}</span>
              </div>
              {prs.length === 0 ? (
                <div className="rounded-control border border-dashed border-line-1/60 px-4 py-12 text-center text-caption leading-relaxed text-ink-3">
                  {t("repo.empty")}
                  <br />
                  <span className="font-mono text-micro">{repo.path}</span>
                </div>
              ) : (
                prs.map((pr) => (
                  <PrRow key={pr.number} pr={pr} onOpen={onOpenPr} />
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 三步各自的「在跑」共用一个骨架：3 行灰条，不是空状态文案。 */
function Skeleton() {
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
      {/* 只复制，不执行：绝不替用户跑 winget / scoop / gh。 */}
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

function UnavailablePanel({
  status,
  onCopy,
  onRedetect,
}: {
  status: GhStatusDto;
  onCopy: (text: string) => void;
  onRedetect: () => void;
}) {
  const { t } = useTranslation();
  // 已安装但未登录：只显示登录那一步；没装才给完整三步。
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

function ResolveFailedPanel({
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
  // 50717 的两个 key 各自是人话；未命中时用 key→码表→msg 的三级回落。
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

function FailedPanel({
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

function PrRow({ pr, onOpen }: { pr: PrDto; onOpen: (pr: PrDto) => void }) {
  const { t } = useTranslation();
  const st = STATE_STYLE[pr.state];
  const checks = CHECKS[pr.checks];
  const CheckIcon = checks.icon;
  return (
    <button
      onClick={() => onOpen(pr)}
      className="mb-1 flex w-full flex-col gap-1.5 rounded-control border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line-1/60 hover:bg-surface-2/50"
    >
      <span className="flex items-start gap-2">
        <span className={cn("mt-0.5 shrink-0 rounded-mark px-1 font-mono text-micro", st)}>
          {t(PR_STATE_LABEL[pr.state])}
        </span>
        <span className="min-w-0 flex-1 text-small leading-snug text-ink-1">
          <span className="mr-1.5 font-mono text-caption text-ink-3">#{pr.number}</span>
          {pr.title}
        </span>
        <CheckIcon className={cn("mt-0.5 size-3.5 shrink-0", checks.className)} />
      </span>
      <span className="flex items-center gap-2 pl-1 font-mono text-micro text-ink-3">
        <span className="truncate">{pr.author.login}</span>
        <span className="truncate">
          {pr.head} → {pr.base}
        </span>
        <span className="ml-auto shrink-0">{formatDateTime(pr.updatedAt)}</span>
      </span>
    </button>
  );
}

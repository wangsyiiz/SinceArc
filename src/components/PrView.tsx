import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Loader2,
  Plus,
  User,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "@/i18n/zh-CN";
import type { CmdError, DiffPageDto, PrDetailDto, PrDto, RepoRefDto } from "@/lib/ipc";
import type { GithubRepo } from "@/types";
import { cn } from "@/lib/utils";
import { errorTextOf } from "@/lib/errors";
import { formatDateTime } from "@/lib/datetime";
import { splitBodyLinks } from "@/lib/pr-body";
import { PR_STATE_LABEL } from "@/lib/pr-state";
import type { DiffPhase } from "@/lib/gh-repo-flow";
import { Button } from "./ui/Button";

const BODY_LIMIT = 4000;

const STATE: Record<PrDto["state"], string> = {
  open: "bg-ok-1/10 text-ok-1",
  draft: "bg-ink-3/10 text-ink-3",
  merged: "bg-warn-1/10 text-warn-1",
  closed: "bg-danger-1/10 text-danger-1",
};

const CHECKS = {
  passing: { icon: CheckCircle2, labelKey: "pr.checks.passing", className: "text-ok-1" },
  failing: { icon: XCircle, labelKey: "pr.checks.failing", className: "text-danger-1" },
  pending: { icon: Loader2, labelKey: "pr.checks.pending", className: "text-warn-1 animate-spin" },
} as const;

/** changeType 由后端统一存小写；没见过的类型按普通文本处理，不造新色。 */
const CHANGE_STYLE: Record<string, { className: string; labelKey: MessageKey }> = {
  added: { className: "text-ok-1", labelKey: "pr.change.added" },
  modified: { className: "text-accent-1", labelKey: "pr.change.modified" },
  deleted: { className: "text-danger-1", labelKey: "pr.change.deleted" },
  renamed: { className: "text-warn-1", labelKey: "pr.change.renamed" },
  copied: { className: "text-ink-2", labelKey: "pr.change.copied" },
};

interface PrViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  prNumber: number;
  detail?: PrDetailDto;
  detailError?: CmdError;
  onRetryDetail?: () => void;
  diff?: DiffPageDto;
  diffPhase: DiffPhase;
  diffError?: CmdError;
  onDiffPage: (page: number) => void;
  onRetryDiff?: () => void;
  onQuote: () => void;
  onOpenExternal: (url: string) => void;
}

export function PrView({
  repo,
  identity,
  prNumber,
  detail,
  detailError,
  onRetryDetail,
  diff,
  diffPhase,
  diffError,
  onDiffPage,
  onRetryDiff,
  onQuote,
  onOpenExternal,
}: PrViewProps) {
  const { t } = useTranslation();
  const pr = detail?.pr;

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line-1/60 px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {pr ? (
            <Header pr={pr} createdAt={detail?.createdAt} />
          ) : (
            <h1 className="font-mono text-body text-ink-3">#{prNumber}</h1>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3.5">
          {!detail && detailError ? (
            <div className="rounded-control border border-dashed border-danger-1/40 px-3 py-3">
              <p className="text-caption text-danger-1">
                {t("pr.detailFailed", { msg: errorTextOf(detailError, t) })}
              </p>
              {onRetryDetail && (
                <Button size="sm" variant="secondary" className="mt-2" onClick={onRetryDetail}>
                  {t("repo.retry")}
                </Button>
              )}
            </div>
          ) : !detail ? (
            <DetailSkeleton />
          ) : (
            <>
              <Body body={detail.body} onOpenExternal={onOpenExternal} />
              <Stats detail={detail} />
              <FileList detail={detail} />
              <DiffView
                diff={diff}
                phase={diffPhase}
                error={diffError}
                onPage={onDiffPage}
                onRetry={onRetryDiff}
              />
              <div className="mt-3 flex gap-1.5">
                <button
                  onClick={onQuote}
                  className="flex items-center gap-1.5 rounded-mark bg-accent-1 px-2.5 py-1.5 text-caption font-medium text-accent-ink transition-[filter] hover:brightness-110"
                >
                  <Plus className="size-3" />
                  {t("pr.quote")}
                </button>
                <button
                  onClick={() => onOpenExternal(pr?.url ?? "")}
                  disabled={!pr?.url}
                  className="flex items-center gap-1 rounded-mark px-2.5 py-1.5 text-caption text-ink-2 transition-colors hover:bg-surface-3/55 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  gh
                  <ArrowUpRight className="size-3" />
                </button>
              </div>
              <div className="mt-4 rounded-control bg-surface-2/30 px-3 py-2 text-caption leading-relaxed text-ink-3">
                {t("pr.readonly")}
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line-1/60 px-3 font-mono text-micro text-ink-3">
        <span className="truncate">
          {identity.owner}/{identity.name}
        </span>
        <span className="truncate">
          {repo.path
            ? t("pr.ghCwd", { path: repo.path })
            : `${identity.host ? `${identity.host}/` : ""}${identity.owner}/${identity.name}`}
        </span>
        <span className="ml-auto shrink-0">{t("pr.cache")}</span>
      </footer>
    </div>
  );
}

function Header({ pr, createdAt }: { pr: PrDto; createdAt?: string }) {
  const { t } = useTranslation();
  const st = STATE[pr.state];
  const checks = CHECKS[pr.checks];
  const CheckIcon = checks.icon;
  return (
    <>
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-body leading-snug font-medium text-ink-1">
          <span className="mr-1.5 font-mono text-small text-ink-3">#{pr.number}</span>
          {pr.title}
        </h1>
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-micro font-medium",
            st,
          )}
        >
          {t(PR_STATE_LABEL[pr.state])}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-micro text-ink-3">
        <span className="flex items-center gap-1">
          <User className="size-2.5" />
          {pr.author.login}
        </span>
        <span className="flex items-center gap-1">
          <GitBranch className="size-2.5" />
          {pr.head} → {pr.base}
        </span>
        <span className="flex items-center gap-1">
          <CheckIcon className={cn("size-2.5", checks.className)} />
          {t(checks.labelKey)}
        </span>
        {createdAt && <span>{t("pr.createdAt", { at: formatDateTime(createdAt) })}</span>}
      </div>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-2">
      <span className="h-3 w-2/3 animate-pulse rounded-control bg-surface-2" />
      <span className="h-3 w-full animate-pulse rounded-control bg-surface-2" />
      <span className="h-3 w-5/6 animate-pulse rounded-control bg-surface-2" />
      <span className="h-20 w-full animate-pulse rounded-control bg-surface-2" />
    </div>
  );
}

/** 纯文本正文：不渲染 markdown、不用 innerHTML；只有白名单链接可点。 */
function Body({
  body,
  onOpenExternal,
}: {
  body: string;
  onOpenExternal: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const truncated = body.length > BODY_LIMIT;
  const shown = truncated && !expanded ? body.slice(0, BODY_LIMIT) : body;
  const segments = useMemo(() => splitBodyLinks(shown), [shown]);

  if (!body.trim()) return null;

  return (
    <section>
      <p className="whitespace-pre-wrap text-small leading-relaxed text-ink-2">
        {segments.map((segment, index) =>
          segment.kind === "link" ? (
            <button
              key={index}
              type="button"
              onClick={() => onOpenExternal(segment.href)}
              className="text-accent-1 underline decoration-accent-1/40 underline-offset-2 transition-colors hover:decoration-accent-1"
            >
              {segment.text}
            </button>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 text-caption text-accent-1 transition-colors hover:underline"
        >
          {expanded ? t("pr.collapse") : t("pr.expand")}
        </button>
      )}
    </section>
  );
}

function Stats({ detail }: { detail: PrDetailDto }) {
  const { t } = useTranslation();
  const total = detail.additions + detail.deletions || 1;
  const addPct = Math.round((detail.additions / total) * 100);
  return (
    <div className="mt-3 rounded-control border border-line-1/60 p-3">
      <div className="flex items-baseline justify-between font-mono text-micro text-ink-3">
        <span>
          {t("pr.files", { count: detail.changedFiles })}
          {detail.filesTruncated && (
            <span className="ml-1.5 text-warn-1">{t("repo.filesTruncated")}</span>
          )}
        </span>
        <span>
          <span className="text-ok-1">+{detail.additions}</span>{" "}
          <span className="text-danger-1">−{detail.deletions}</span>
        </span>
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-danger-1/40">
        <div className="h-full bg-ok-1" style={{ width: `${addPct}%` }} />
      </div>
    </div>
  );
}

function FileList({ detail }: { detail: PrDetailDto }) {
  const { t } = useTranslation();
  if (detail.files.length === 0) return null;
  return (
    <ul className="mt-3 divide-y divide-line-1/40 rounded-control border border-line-1/60">
      {detail.files.map((file) => (
        <li key={file.path} className="flex items-center gap-2 px-2.5 py-1 font-mono text-micro">
          <span className={cn("shrink-0", CHANGE_STYLE[file.changeType]?.className ?? "text-ink-3")}>
            {CHANGE_STYLE[file.changeType] ? t(CHANGE_STYLE[file.changeType].labelKey) : file.changeType}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-2">{file.path}</span>
          <span className="shrink-0 text-ok-1">+{file.additions}</span>
          <span className="shrink-0 text-danger-1">−{file.deletions}</span>
        </li>
      ))}
    </ul>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "text-ink-3";
  if (line.startsWith("+")) return "text-ok-1";
  if (line.startsWith("-")) return "text-danger-1";
  return "text-ink-2";
}

function DiffView({
  diff,
  phase,
  error,
  onPage,
  onRetry,
}: {
  diff?: DiffPageDto;
  phase: DiffPhase;
  error?: CmdError;
  onPage: (page: number) => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const totalPages = diff?.totalPages ?? 0;
  const page = diff?.page ?? 0;
  const hasPrev = page > 0;
  const hasNext = totalPages > 0 && page + 1 < totalPages;

  return (
    <section className="mt-3">
      <div className="mb-1 flex items-center gap-2 text-micro tracking-wide text-ink-3">
        <span>{t("pr.diff.title")}</span>
        {phase === "loading" && <Loader2 className="size-3 animate-spin" />}
      </div>

      {phase === "failed" ? (
        <div className="rounded-control border border-dashed border-danger-1/40 px-3 py-2">
          <p className="text-caption text-danger-1">
            {t("pr.diff.failed", {
              msg: error ? errorTextOf(error, t) : "",
            })}
          </p>
          {onRetry && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
              {t("repo.retry")}
            </Button>
          )}
        </div>
      ) : diff && diff.lines.length > 0 ? (
        <pre className="max-h-96 overflow-auto rounded-control border border-line-1/60 bg-surface-1/40 p-2 text-micro leading-relaxed">
          {diff.lines.map((line, index) => (
            <span key={index} className={cn("block whitespace-pre", lineClass(line))}>
              {line || " "}
            </span>
          ))}
        </pre>
      ) : phase === "ready" ? (
        <p className="px-1 py-2 text-caption text-ink-3">{t("pr.diff.empty")}</p>
      ) : null}

      {diff && (
        <div className="mt-1.5 flex items-center gap-2 font-mono text-micro text-ink-3">
          <span>
            {t("pr.diff.page", {
              page: page + 1,
              total: totalPages,
              lines: diff.totalLines,
              size: diff.pageSize,
            })}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={!hasPrev} onClick={() => onPage(page - 1)}>
              <ChevronLeft className="size-3" />
              {t("pr.diff.prev")}
            </Button>
            <Button size="sm" variant="ghost" disabled={!hasNext} onClick={() => onPage(page + 1)}>
              {t("pr.diff.next")}
              <ChevronRight className="size-3" />
            </Button>
          </span>
        </div>
      )}
    </section>
  );
}

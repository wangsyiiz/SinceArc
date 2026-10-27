import {
  CheckCircle2,
  CircleDot,
  FolderGit2,
  Loader2,
  MessageSquare,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GithubPR, GithubRepo } from "@/types";
import { cn } from "@/lib/utils";
import { localizeText } from "@/lib/i18n-text";

const STATE_STYLE: Record<GithubPR["state"], { className: string; label: string }> = {
  open: { className: "text-ok-1", label: "open" },
  draft: { className: "text-ink-3", label: "draft" },
  merged: { className: "text-warn-1", label: "merged" },
  closed: { className: "text-danger-1", label: "closed" },
};

const CHECKS = {
  passing: { icon: CheckCircle2, className: "text-ok-1" },
  failing: { icon: XCircle, className: "text-danger-1" },
  pending: { icon: Loader2, className: "text-warn-1 animate-spin" },
} as const;

interface RepoBrowserProps {
  repo: GithubRepo;
  prs: GithubPR[];
  onOpenPr: (pr: GithubPR) => void;
}

export function RepoBrowser({ repo, prs, onOpenPr }: RepoBrowserProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
        <FolderGit2 className="size-3.5 text-ink-2" />
        <span className="text-small font-medium text-ink-1">{localizeText(repo.name, t)}</span>
        <span className="truncate font-mono text-micro text-ink-3">{repo.slug}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-micro text-ink-3">
          <span className="rounded-mark bg-surface-3/45 px-1.5 py-0.5">{repo.branch}</span>
          <span className="max-w-60 truncate">{repo.path}</span>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
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
            prs.map((pr) => {
              const st = STATE_STYLE[pr.state];
              const checks = CHECKS[pr.checks];
              const CheckIcon = checks.icon;
              return (
                <button
                  key={pr.number}
                  onClick={() => onOpenPr(pr)}
                  className="mb-1 flex w-full flex-col gap-1.5 rounded-control border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line-1/60 hover:bg-surface-2/50"
                >
                  <span className="flex items-start gap-2">
                    <CircleDot className={cn("mt-0.5 size-3.5 shrink-0", st.className)} />
                    <span className="min-w-0 flex-1 text-small leading-snug text-ink-1">
                      <span className="mr-1.5 font-mono text-caption text-ink-3">#{pr.number}</span>
                      {pr.title}
                    </span>
                    <CheckIcon className={cn("mt-0.5 size-3.5 shrink-0", checks.className)} />
                  </span>
                  <span className="flex items-center gap-2 pl-5 font-mono text-micro text-ink-3">
                    <span className="truncate">{pr.head}</span>
                    <span>→</span>
                    <span>{pr.base}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2.5">
                      <span className="text-ok-1">+{pr.additions}</span>
                      <span className="text-danger-1">−{pr.deletions}</span>
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="size-2.5" />
                        {pr.comments}
                      </span>
                      <span>{pr.updatedAt}</span>
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

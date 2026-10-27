import { ArrowUpRight, CheckCircle2, GitBranch, Loader2, Plus, User, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GithubPR, GithubRepo } from "@/types";
import { cn } from "@/lib/utils";

const STATE: Record<GithubPR["state"], { className: string; label: string }> = {
  open: { className: "bg-ok-1/10 text-ok-1", label: "Open" },
  draft: { className: "bg-ink-3/10 text-ink-3", label: "Draft" },
  merged: { className: "bg-warn-1/10 text-warn-1", label: "Merged" },
  closed: { className: "bg-danger-1/10 text-danger-1", label: "Closed" },
};

const CHECKS = {
  passing: { icon: CheckCircle2, labelKey: "pr.checks.passing", className: "text-ok-1" },
  failing: { icon: XCircle, labelKey: "pr.checks.failing", className: "text-danger-1" },
  pending: { icon: Loader2, labelKey: "pr.checks.pending", className: "text-warn-1 animate-spin" },
} as const;

interface PrViewProps {
  pr: GithubPR;
  repo: GithubRepo;
  onQuote: () => void;
}

export function PrView({ pr, repo, onQuote }: PrViewProps) {
  const { t } = useTranslation();
  const st = STATE[pr.state];
  const checks = CHECKS[pr.checks];
  const CheckIcon = checks.icon;
  const total = pr.additions + pr.deletions || 1;
  const addPct = Math.round((pr.additions / total) * 100);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line-1/60 px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 flex-1 text-body leading-snug font-medium text-ink-1">
              <span className="mr-1.5 font-mono text-small text-ink-3">#{pr.number}</span>
              {pr.title}
            </h1>
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-micro font-medium",
                st.className,
              )}
            >
              {st.label}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-micro text-ink-3">
            <span className="flex items-center gap-1">
              <User className="size-2.5" />
              {pr.author}
            </span>
            <span className="flex items-center gap-1">
              <GitBranch className="size-2.5" />
              {pr.head} → {pr.base}
            </span>
            <span className="flex items-center gap-1">
              <CheckIcon className={cn("size-2.5", checks.className)} />
              {t(checks.labelKey)}
            </span>
            <span>{pr.updatedAt}</span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3.5">
          <p className="text-small leading-relaxed text-ink-2">{pr.body}</p>

          <div className="mt-3 rounded-control border border-line-1/60 p-3">
            <div className="flex items-baseline justify-between font-mono text-micro text-ink-3">
              <span>{t("pr.files", { count: pr.files })}</span>
              <span>
                <span className="text-ok-1">+{pr.additions}</span>{" "}
                <span className="text-danger-1">−{pr.deletions}</span>
              </span>
            </div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-danger-1/40">
              <div className="h-full bg-ok-1" style={{ width: `${addPct}%` }} />
            </div>
          </div>

          <div className="mt-3 flex gap-1.5">
            <button
              onClick={onQuote}
              className="flex items-center gap-1.5 rounded-mark bg-accent-1 px-2.5 py-1.5 text-caption font-medium text-accent-ink transition-[filter] hover:brightness-110"
            >
              <Plus className="size-3" />
              {t("pr.quote")}
            </button>
            <button className="flex items-center gap-1 rounded-mark px-2.5 py-1.5 text-caption text-ink-2 transition-colors hover:bg-surface-3/55">
              gh
              <ArrowUpRight className="size-3" />
            </button>
          </div>

          <div className="mt-4 rounded-control bg-surface-2/30 px-3 py-2 text-caption leading-relaxed text-ink-3">
            {t("pr.readonly")}
          </div>
        </div>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line-1/60 px-3 font-mono text-micro text-ink-3">
        <span className="truncate">{t("pr.ghCwd", { path: repo.path })}</span>
        <span className="ml-auto shrink-0">{t("pr.cache")}</span>
      </footer>
    </div>
  );
}

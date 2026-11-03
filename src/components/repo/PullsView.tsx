import { useMemo } from "react";
import {
  CheckCircle2,
  GitPullRequest,
  Loader2,
  MessageSquare,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PrDto, RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/datetime";
import { PR_STATE_LABEL } from "@/lib/pr-state";
import { capabilityMap } from "@/lib/gh-display";
import { useRepoCapabilities } from "@/hooks/useRepoData";
import { BackToDashboard } from "./BackToDashboard";
import { RepoHeader } from "./RepoChrome";
import { WriteAction } from "./WriteAction";

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

interface PullsViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  prs: PrDto[];
  onOpenPr: (pr: PrDto) => void;
  onSelectView: (view: RepoView) => void;
}

export function PullsView({
  repo,
  identity,
  prs,
  onOpenPr,
  onSelectView,
}: PullsViewProps) {
  const { t } = useTranslation();
  const capabilities = useRepoCapabilities(identity, true);
  const caps = useMemo(() => capabilityMap(capabilities.data?.actions), [capabilities.data]);

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <BackToDashboard onBack={() => onSelectView("dashboard")} />
          <div className="mb-2 flex items-center gap-2">
            <GitPullRequest className="size-3.5 text-ink-3" />
            <span className="text-micro uppercase tracking-wide text-ink-3">
              {t("repo.dash.pulls.heading")}
            </span>
            <span className="font-mono text-micro text-ink-3">{prs.length}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <WriteAction
                action="pr_comment"
                label={t("repo.dash.write.comment")}
                capabilities={caps}
                icon={<MessageSquare className="size-3" />}
              />
              <WriteAction
                action="pr_merge"
                label={t("repo.dash.write.merge")}
                capabilities={caps}
              />
            </span>
          </div>
          {prs.length === 0 ? (
            <div className="rounded-control border border-dashed border-line-1/60 px-4 py-12 text-center text-caption leading-relaxed text-ink-3">
              {t("repo.empty")}
              <br />
              <span className="font-mono text-micro">{`${identity.owner}/${identity.name}`}</span>
            </div>
          ) : (
            prs.map((pr) => <PrRow key={pr.number} pr={pr} onOpen={onOpenPr} />)
          )}
        </div>
      </div>
    </div>
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

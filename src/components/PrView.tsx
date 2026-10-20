import { ArrowUpRight, CheckCircle2, GitBranch, Loader2, Plus, User, XCircle } from "lucide-react";
import type { GithubPR, GithubRepo } from "@/types";
import { cn } from "@/lib/utils";

const STATE: Record<GithubPR["state"], { color: string; label: string; bg: string }> = {
  open: { color: "var(--ok)", label: "Open", bg: "rgb(63 185 80 / 0.12)" },
  draft: { color: "var(--i2)", label: "Draft", bg: "rgb(255 255 255 / 0.06)" },
  merged: { color: "#a371f7", label: "Merged", bg: "rgb(163 113 247 / 0.12)" },
  closed: { color: "var(--d1)", label: "Closed", bg: "rgb(248 81 73 / 0.12)" },
};

const CHECKS = {
  passing: { icon: CheckCircle2, label: "checks 通过", className: "text-ok-1" },
  failing: { icon: XCircle, label: "checks 失败", className: "text-danger-1" },
  pending: { icon: Loader2, label: "checks 进行中", className: "text-warn-1 animate-spin" },
} as const;

interface PrViewProps {
  pr: GithubPR;
  repo: GithubRepo;
  onQuote: () => void;
}

export function PrView({ pr, repo, onQuote }: PrViewProps) {
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
            <h1 className="min-w-0 flex-1 text-[14px] leading-snug font-medium text-ink-1">
              <span className="mr-1.5 font-mono text-[12px] text-ink-3">#{pr.number}</span>
              {pr.title}
            </h1>
            <span
              className="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ color: st.color, background: st.bg }}
            >
              {st.label}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-ink-3">
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
              {checks.label}
            </span>
            <span>{pr.updatedAt}</span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-ink-2">{pr.body}</p>

          <div className="mt-3 rounded-[8px] border border-line-1/60 p-3">
            <div className="flex items-baseline justify-between font-mono text-[10px] text-ink-3">
              <span>{pr.files} 个文件</span>
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
              className="flex items-center gap-1.5 rounded-[6px] bg-accent-1 px-2.5 py-1.5 text-[11px] font-medium text-accent-ink transition-all hover:brightness-110"
            >
              <Plus className="size-3" />
              加入对话
            </button>
            <button className="flex items-center gap-1 rounded-[6px] px-2.5 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-white/[0.06]">
              gh
              <ArrowUpRight className="size-3" />
            </button>
          </div>

          <div className="mt-4 rounded-[8px] bg-white/[0.02] px-3 py-2 text-[10.5px] leading-relaxed text-ink-3">
            视图内容只读。「加入对话」把这条 PR 的摘要作为引用塞进会话，由 agent 自己去读 diff ——
            客户端不代跑 gh 的写操作。
          </div>
        </div>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line-1/60 px-3 font-mono text-[9.5px] text-ink-3">
        <span className="truncate">gh cwd: {repo.path}</span>
        <span className="ml-auto shrink-0">缓存 30s</span>
      </footer>
    </div>
  );
}

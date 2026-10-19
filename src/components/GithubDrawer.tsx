import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  FolderGit2,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Plus,
  X,
  XCircle,
} from "lucide-react";
import type { GithubPR, GithubRepo } from "@/types";
import { cn } from "@/lib/utils";

interface GithubDrawerProps {
  repos: GithubRepo[];
  prsByRepo: Record<string, GithubPR[]>;
  onAddRepo: (path: string) => void;
  onClose: () => void;
  onQuote: (pr: GithubPR, repo: GithubRepo) => void;
}

const STATE_STYLE: Record<GithubPR["state"], { color: string; label: string }> = {
  open: { color: "var(--ok)", label: "open" },
  draft: { color: "var(--i3)", label: "draft" },
  merged: { color: "#a371f7", label: "merged" },
  closed: { color: "var(--d1)", label: "closed" },
};

const CHECKS = {
  passing: { icon: CheckCircle2, className: "text-ok-1" },
  failing: { icon: XCircle, className: "text-danger-1" },
  pending: { icon: Loader2, className: "text-warn-1 animate-spin" },
} as const;

export function GithubDrawer({ repos, prsByRepo, onAddRepo, onClose, onQuote }: GithubDrawerProps) {
  const [activeId, setActiveId] = useState(repos[0]?.id ?? "");
  const [tab, setTab] = useState<"prs" | "issues" | "actions">("prs");
  const [openPr, setOpenPr] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");

  const repo = repos.find((r) => r.id === activeId) ?? repos[0];
  const list = repo ? (prsByRepo[repo.id] ?? []) : [];

  const submitPath = () => {
    const v = path.trim();
    if (!v) return;
    onAddRepo(v);
    setPath("");
    setAdding(false);
  };

  return (
    <aside className="sc-glass absolute right-1 top-9 bottom-1 z-30 flex w-[386px] flex-col overflow-hidden rounded-[12px]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
        <GitPullRequest className="size-3.5 text-ink-2" />
        <span className="text-[12px] font-medium">GitHub</span>
        <span className="ml-auto font-mono text-[9.5px] text-ink-3">{repos.length} 个项目</span>
        <button
          onClick={onClose}
          className="grid size-6 place-items-center rounded-[6px] text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
        >
          <X className="size-3.5" />
        </button>
      </header>

      {/* 项目切换：与聊天窗口无关，各自独立 */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line-1/40 px-2.5 py-2">
        {repos.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              setActiveId(r.id);
              setOpenPr(null);
            }}
            title={`${r.path}\n${r.slug}`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10.5px] transition-colors",
              activeId === r.id
                ? "border-line-2 bg-white/[0.08] text-ink-1"
                : "border-transparent text-ink-3 hover:bg-white/[0.04] hover:text-ink-2",
            )}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ background: r.connected ? "var(--ok)" : "var(--i3)" }}
            />
            {r.name}
          </button>
        ))}
        <button
          onClick={() => setAdding((v) => !v)}
          title="添加项目路径"
          className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {adding && (
        <div className="shrink-0 border-b border-line-1/40 px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <FolderGit2 className="size-3 shrink-0 text-ink-3" />
            <input
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPath();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="/home/jerry/source/项目路径"
              className="sc-selectable min-w-0 flex-1 rounded-[6px] bg-white/[0.05] px-2 py-1 font-mono text-[10.5px] text-ink-1 outline-none placeholder:text-ink-3"
            />
            <button
              onClick={submitPath}
              className="rounded-[6px] bg-accent-1 px-2 py-1 text-[10.5px] font-medium text-accent-ink transition-all hover:brightness-110"
            >
              添加
            </button>
          </div>
          <p className="mt-1 pl-[18px] text-[9.5px] text-ink-3">
            添加到列表；执行 gh 命令时后端把 cwd 切到这个目录
          </p>
        </div>
      )}

      <div className="flex shrink-0 gap-1 px-2.5 py-2">
        {(
          [
            ["prs", "Pull requests", list.length],
            ["issues", "Issues", 0],
            ["actions", "Actions", 0],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11px] transition-colors",
              tab === id ? "bg-white/[0.07] text-ink-1" : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2",
            )}
          >
            {label}
            {count > 0 && <span className="font-mono text-[9.5px] text-ink-3">{count}</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tab !== "prs" ? (
          <div className="py-10 text-center text-[11px] text-ink-3">未接线</div>
        ) : list.length === 0 ? (
          <div className="px-4 py-10 text-center text-[11px] leading-relaxed text-ink-3">
            这个项目还没有 PR
            <br />
            <span className="font-mono text-[9.5px]">{repo?.path}</span>
          </div>
        ) : (
          list.map((pr) => {
            const st = STATE_STYLE[pr.state];
            const checks = CHECKS[pr.checks];
            const CheckIcon = checks.icon;
            const expanded = openPr === pr.number;
            return (
              <div
                key={pr.number}
                className={cn(
                  "mb-1 rounded-[8px] border transition-colors",
                  expanded ? "border-line-1 bg-white/[0.035]" : "border-transparent hover:bg-white/[0.03]",
                )}
              >
                <button
                  onClick={() => setOpenPr(expanded ? null : pr.number)}
                  className="flex w-full flex-col gap-1 px-2 py-1.5 text-left"
                >
                  <span className="flex items-start gap-1.5">
                    <CircleDot className="mt-[3px] size-3 shrink-0" style={{ color: st.color }} />
                    <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-1">
                      <span className="mr-1 font-mono text-[10px] text-ink-3">#{pr.number}</span>
                      {pr.title}
                    </span>
                    <CheckIcon className={cn("mt-[2px] size-3 shrink-0", checks.className)} />
                  </span>
                  <span className="flex items-center gap-2 pl-[18px] font-mono text-[9.5px] text-ink-3">
                    <span className="truncate">{pr.head}</span>
                    <span>→</span>
                    <span>{pr.base}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <span className="text-ok-1">+{pr.additions}</span>
                      <span className="text-danger-1">−{pr.deletions}</span>
                      <span className="flex items-center gap-0.5">
                        <MessageSquare className="size-2.5" />
                        {pr.comments}
                      </span>
                    </span>
                  </span>
                </button>

                {expanded && (
                  <div className="border-t border-line-1/50 px-2.5 py-2">
                    <p className="text-[11px] leading-relaxed text-ink-2">{pr.body}</p>
                    <div className="mt-2 flex items-center gap-2 font-mono text-[9.5px] text-ink-3">
                      <span style={{ color: st.color }}>{st.label}</span>
                      <span>·</span>
                      <span>{pr.files} 文件</span>
                      <span>·</span>
                      <span>{pr.updatedAt}</span>
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <button
                        onClick={() => repo && onQuote(pr, repo)}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-[6px] bg-accent-1 py-1.5 text-[11px] font-medium text-accent-ink transition-all hover:brightness-110"
                      >
                        <Plus className="size-3" />
                        加入对话
                      </button>
                      <button className="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-white/[0.06]">
                        gh
                        <ArrowUpRight className="size-3" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line-1/60 px-3 font-mono text-[9.5px] text-ink-3">
        <span className="truncate">gh cwd: {repo?.path ?? "—"}</span>
        <span className="ml-auto shrink-0">{repo?.branch ?? ""} · 缓存 30s</span>
      </footer>
    </aside>
  );
}

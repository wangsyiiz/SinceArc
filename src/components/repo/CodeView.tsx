import { useState } from "react";
import { ChevronRight, File, Folder, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RepoRefDto } from "@/lib/ipc";
import type { GithubRepo, RepoView } from "@/types";
import { formatBytes } from "@/lib/relative-time";
import { useRepoTree } from "@/hooks/useRepoData";
import { BackToDashboard } from "./BackToDashboard";
import { RepoHeader, RepoLoadError } from "./RepoChrome";

interface CodeViewProps {
  repo: GithubRepo;
  identity: RepoRefDto;
  onSelectView: (view: RepoView) => void;
}

export function CodeView({ repo, identity, onSelectView }: CodeViewProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string | null>(null);
  const tree = useRepoTree(identity, true, path);
  const items = tree.data?.items ?? [];
  const parts = path ? path.split("/").filter(Boolean) : [];

  return (
    <div className="flex h-full flex-col">
      <RepoHeader repo={repo} identity={identity} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <BackToDashboard onBack={() => onSelectView("dashboard")} />
          <div className="mb-2 flex items-center gap-2">
            <FolderTree className="size-3.5 text-ink-3" />
            <span className="text-micro uppercase tracking-wide text-ink-3">
              {t("repo.dash.code.heading")}
            </span>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-0.5 font-mono text-micro text-ink-3">
            <button
              type="button"
              onClick={() => setPath(null)}
              className="rounded-mark px-1.5 py-0.5 hover:bg-surface-2/60 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              {t("repo.dash.code.root")}
            </button>
            {parts.map((part, index) => {
              const target = parts.slice(0, index + 1).join("/");
              return (
                <span key={target} className="flex items-center gap-0.5">
                  <ChevronRight className="size-3" />
                  <button
                    type="button"
                    onClick={() => setPath(target)}
                    className="rounded-mark px-1.5 py-0.5 hover:bg-surface-2/60 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                  >
                    {part}
                  </button>
                </span>
              );
            })}
          </div>

          {tree.loading ? (
            <div className="flex flex-col gap-2 py-1" role="status">
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
              <span className="h-9 w-full animate-pulse rounded-control bg-surface-2" />
            </div>
          ) : tree.error ? (
            <RepoLoadError error={tree.error} onRetry={() => tree.reload(true)} />
          ) : items.length === 0 ? (
            <div className="rounded-control border border-dashed border-line-1/60 px-4 py-12 text-center text-caption text-ink-3">
              {t("repo.dash.code.empty")}
            </div>
          ) : (
            [...items]
              .sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map((entry) =>
                entry.kind === "dir" ? (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => setPath(entry.path)}
                    className="mb-1 flex w-full items-center gap-2 rounded-control border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line-1/60 hover:bg-surface-2/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                  >
                    <Folder className="size-3.5 shrink-0 text-accent-1" />
                    <span className="min-w-0 flex-1 truncate text-small text-ink-1">
                      {entry.name}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
                  </button>
                ) : (
                  <div
                    key={entry.path}
                    className="mb-1 flex items-center gap-2 rounded-control px-2.5 py-2"
                  >
                    <File className="size-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate text-small text-ink-1">
                      {entry.name}
                    </span>
                    <span className="shrink-0 font-mono text-micro text-ink-3">
                      {formatBytes(entry.size)}
                    </span>
                  </div>
                ),
              )
          )}
        </div>
      </div>
    </div>
  );
}

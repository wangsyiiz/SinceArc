import { useCallback, useState } from "react";
import { newId } from "@/lib/ids";
import type { GithubPR, GithubRepo, Tab } from "@/types";

export const EMPTY_PRS: Record<string, GithubPR[]> = {};

export function useRepos(activeTab: Tab | null) {
  const [repoList, setRepoList] = useState<GithubRepo[]>([]);

  const addRepo = useCallback((path: string) => {
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "新项目";
    setRepoList((prev) => [
      ...prev,
      { id: newId("repo"), name, slug: `—/${name}`, path, branch: "—", connected: false },
    ]);
  }, []);

  const activeRepo = activeTab?.repoId
    ? repoList.find((r) => r.id === activeTab.repoId)
    : undefined;

  const activePr =
    activeTab?.kind === "pr" && activeTab.repoId
      ? (EMPTY_PRS[activeTab.repoId] ?? []).find(
          (pr) => pr.number === activeTab.prNumber,
        )
      : undefined;

  return { repoList, addRepo, activeRepo, activePr };
}

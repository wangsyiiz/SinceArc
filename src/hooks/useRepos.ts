import { useCallback, useMemo, useState } from "react";
import { prsByRepo, repos as seedRepos } from "@/mock/data";
import type { GithubRepo, Tab } from "@/types";

export function useRepos(activeTab: Tab | null) {
  const [repoList, setRepoList] = useState<GithubRepo[]>(seedRepos);

  const addRepo = useCallback((path: string) => {
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "新项目";
    setRepoList((prev) => [
      ...prev,
      { id: `r-${Date.now()}`, name, slug: `—/${name}`, path, branch: "—", connected: false },
    ]);
  }, []);

  const activeRepo = activeTab?.repoId
    ? repoList.find((r) => r.id === activeTab.repoId)
    : undefined;

  const activePr = useMemo(() => {
    if (activeTab?.kind !== "pr" || !activeTab.repoId) return undefined;
    return (prsByRepo[activeTab.repoId] ?? []).find((p) => p.number === activeTab.prNumber);
  }, [activeTab]);

  return { repoList, addRepo, activeRepo, activePr };
}

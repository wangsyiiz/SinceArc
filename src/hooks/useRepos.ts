import { useCallback, useState } from "react";
import { newId } from "@/lib/ids";
import { i18nText } from "@/lib/i18n-text";
import type { GithubPR, GithubRepo, Tab } from "@/types";

export const EMPTY_PRS: Record<string, GithubPR[]> = {};

export function useRepos(activeTab: Tab | null) {
  const [repoList, setRepoList] = useState<GithubRepo[]>([]);

  const addRepo = useCallback((path: string) => {
    const folder = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    const name = folder || i18nText("sidebar.newProject");
    setRepoList((prev) => [
      ...prev,
      {
        id: newId("repo"),
        name,
        slug: `—/${folder || "new-project"}`,
        path,
        branch: "—",
        connected: false,
      },
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

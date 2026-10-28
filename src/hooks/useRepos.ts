import { useCallback, useState } from "react";
import { newId } from "@/lib/ids";
import { i18nText } from "@/lib/i18n-text";
import type { GithubRepo, Tab } from "@/types";

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
        path,
      },
    ]);
  }, []);

  // repo 与 pr 两种标签都挂在同一个 repo 上：PR 标签也需要 path 去解析身份。
  const activeRepo = activeTab?.repoId
    ? repoList.find((r) => r.id === activeTab.repoId)
    : undefined;

  return { repoList, addRepo, activeRepo };
}

import type { RepoView, Tab } from "@/types";

export const REPO_VIEWS: readonly RepoView[] = [
  "dashboard",
  "pulls",
  "issues",
  "actions",
  "releases",
  "code",
  "settings",
];

/** 认不出的 view 一律落 dashboard；深链与标签投影共用这一处。 */
export function repoViewOf(value: unknown): RepoView {
  return REPO_VIEWS.includes(value as RepoView) ? (value as RepoView) : "dashboard";
}

/** tabs 是唯一真源，这里只把激活标签投影成路径。 */
export function pathOfTab(
  tab: Pick<Tab, "sessionId" | "repoId" | "prNumber" | "view"> & { kind: string },
): string | null {
  switch (tab.kind) {
    case "session":
      return tab.sessionId ? `/session/${tab.sessionId}` : null;
    case "repo": {
      if (!tab.repoId) return null;
      const view = repoViewOf(tab.view);
      return view === "dashboard" ? `/repo/${tab.repoId}` : `/repo/${tab.repoId}/${view}`;
    }
    case "pr":
      return tab.repoId && tab.prNumber != null
        ? `/pr/${tab.repoId}/${tab.prNumber}`
        : null;
    case "settings":
      return "/settings";
    default:
      return null;
  }
}

import type { Tab } from "@/types";

/** tabs 是唯一真源，这里只把激活标签投影成路径。 */
export function pathOfTab(
  tab: Pick<Tab, "sessionId" | "repoId" | "prNumber"> & { kind: string },
): string | null {
  switch (tab.kind) {
    case "session":
      return tab.sessionId ? `/session/${tab.sessionId}` : null;
    case "repo":
      return tab.repoId ? `/repo/${tab.repoId}` : null;
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

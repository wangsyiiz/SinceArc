import { useCallback, useEffect, useState } from "react";
import type { CmdError, RepoDto } from "@/lib/ipc";
import {
  asCmdError,
  reposAddLocal,
  reposAddRemote,
  reposList,
  reposPin,
  reposRemoveLocal,
} from "@/lib/ipc";
import { normalizeRepoPath } from "@/lib/repo-path";
import type { GithubRepo, Tab } from "@/types";

function toGithubRepo(dto: RepoDto): GithubRepo {
  const locals = dto.locals.map((local) => ({
    id: local.id,
    path: local.path,
    hostKind: local.hostKind,
  }));
  return {
    id: dto.id,
    host: dto.host,
    owner: dto.owner,
    name: dto.name,
    slug: dto.host ? `${dto.host}/${dto.owner}/${dto.name}` : `${dto.owner}/${dto.name}`,
    defaultBranch: dto.defaultBranch,
    pinned: dto.pinned,
    lastUsedAt: dto.lastUsedAt,
    locals,
    path: locals[0]?.path ?? "",
  };
}

export interface AddFromGhInput {
  host?: string | null;
  owner: string;
  name: string;
  defaultBranch?: string | null;
}

export function useRepos(activeTab: Tab | null) {
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CmdError | null>(null);

  const refresh = useCallback(async () => {
    const dto = await reposList();
    const next = dto.items.map(toGithubRepo);
    setRepos(next);
    setError(null);
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    void reposList()
      .then((dto) => {
        if (!alive) return;
        setRepos(dto.items.map(toGithubRepo));
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(asCmdError(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 侧栏沿用同名同签名；实际动作改成 IPC 落库后刷新列表。 */
  const addRepo = useCallback(
    (path: string) => {
      const normalized = normalizeRepoPath(path);
      void reposAddLocal(normalized)
        .then(() => refresh())
        .catch((err: unknown) => setError(asCmdError(err)));
    },
    [refresh],
  );

  const addFromGh = useCallback(
    async (input: AddFromGhInput) => {
      try {
        const dto = await reposAddRemote(
          input.host ?? "",
          input.owner,
          input.name,
          input.defaultBranch ?? null,
        );
        await refresh();
        return dto;
      } catch (err: unknown) {
        setError(asCmdError(err));
        throw err;
      }
    },
    [refresh],
  );

  const pin = useCallback(
    async (repoId: string, pinned: boolean) => {
      try {
        await reposPin(repoId, pinned);
        await refresh();
      } catch (err: unknown) {
        setError(asCmdError(err));
        throw err;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (path: string) => {
      try {
        await reposRemoveLocal(normalizeRepoPath(path));
        await refresh();
      } catch (err: unknown) {
        setError(asCmdError(err));
        throw err;
      }
    },
    [refresh],
  );

  // repo 与 pr 两种标签都挂在同一个 repo 上：PR 标签也需要 path 去解析身份。
  const activeRepo = activeTab?.repoId
    ? repos.find((repo) => repo.id === activeTab.repoId)
    : undefined;

  return {
    repos,
    /** 侧栏现有调用点沿用这个名字。 */
    repoList: repos,
    addRepo,
    addFromGh,
    pin,
    remove,
    activeRepo,
    loading,
    error,
  };
}

/**
 * dashboard / 六个子页的数据获取：hook + `useState`/`useEffect`，不引入 react-query。
 *
 * 每个资源独立成一份 `ResourceState`，一块失败不会把整页打白（docs/gh.md §10.5）。
 * `reload(true)` 走 `force`，绕过 domain 缓存；错误统一归一成 `CmdError`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  asCmdError,
  ghCapabilities,
  ghIssueList,
  ghReleaseList,
  ghRepoSummary,
  ghRepoTree,
  ghRunsList,
  ghWorkflowsList,
  type CapabilitiesDto,
  type CmdError,
  type IssueListDto,
  type ReleaseListDto,
  type RepoRefDto,
  type RepoSummaryDto,
  type TreeEntryListDto,
  type WorkflowListDto,
  type WorkflowRunListDto,
} from "@/lib/ipc";

export interface ResourceState<T> {
  loading: boolean;
  data?: T;
  error?: CmdError;
}

export interface Resource<T> extends ResourceState<T> {
  reload: (force?: boolean) => void;
}

function useResource<T>(
  enabled: boolean,
  key: string,
  load: (force: boolean) => Promise<T>,
): Resource<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const forceRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({ loading: enabled });

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    const force = forceRef.current;
    forceRef.current = false;
    setState({ loading: true });
    void loadRef
      .current(force)
      .then((data) => {
        if (alive) setState({ loading: false, data });
      })
      .catch((error: unknown) => {
        if (alive) setState({ loading: false, error: asCmdError(error) });
      });
    return () => {
      alive = false;
    };
  }, [enabled, key, tick]);

  const reload = useCallback((force = false) => {
    forceRef.current = force;
    setTick((value) => value + 1);
  }, []);

  return { ...state, reload };
}

function repoKey(repo: RepoRefDto | undefined): string {
  if (!repo) return "";
  return `${repo.host ?? ""}|${repo.owner}|${repo.name}`;
}

export function useRepoSummary(repo: RepoRefDto | undefined, enabled: boolean) {
  return useResource(
    enabled && !!repo,
    repoKey(repo),
    (force) => ghRepoSummary(repo as RepoRefDto, force),
  );
}

export function useRepoIssues(repo: RepoRefDto | undefined, enabled: boolean) {
  return useResource(
    enabled && !!repo,
    repoKey(repo),
    (force) => ghIssueList(repo as RepoRefDto, "open", 50, force),
  );
}

export function useRepoReleases(repo: RepoRefDto | undefined, enabled: boolean, limit = 50) {
  return useResource(
    enabled && !!repo,
    `${repoKey(repo)}|${limit}`,
    (force) => ghReleaseList(repo as RepoRefDto, limit, force),
  );
}

export function useRepoRuns(repo: RepoRefDto | undefined, enabled: boolean, limit = 20) {
  return useResource(
    enabled && !!repo,
    `${repoKey(repo)}|${limit}`,
    (force) => ghRunsList(repo as RepoRefDto, limit, force),
  );
}

export function useRepoWorkflows(repo: RepoRefDto | undefined, enabled: boolean) {
  return useResource(
    enabled && !!repo,
    repoKey(repo),
    (force) => ghWorkflowsList(repo as RepoRefDto, force),
  );
}

export function useRepoTree(
  repo: RepoRefDto | undefined,
  enabled: boolean,
  path: string | null,
) {
  return useResource(
    enabled && !!repo,
    `${repoKey(repo)}|${path ?? ""}`,
    (force) => ghRepoTree(repo as RepoRefDto, path, null, force),
  );
}

export function useRepoCapabilities(repo: RepoRefDto | undefined, enabled: boolean) {
  return useResource(
    enabled && !!repo,
    repoKey(repo),
    () => ghCapabilities(repo as RepoRefDto),
  );
}

export type {
  CapabilitiesDto,
  IssueListDto,
  ReleaseListDto,
  RepoSummaryDto,
  TreeEntryListDto,
  WorkflowListDto,
  WorkflowRunListDto,
};

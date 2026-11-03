/**
 * 我的 open PR：首屏读后端缓存，之后只靠 `gh:open-prs` 事件更新（docs/gh.md §13.2）。
 * 前端不轮询；面板里的「刷新」显式 force 一次。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  asCmdError,
  ghMyPrs,
  onOpenPrs,
  type CmdError,
  type MyPrsDto,
} from "@/lib/ipc";

export interface MyPrsResource {
  data?: MyPrsDto;
  error?: CmdError;
  loading: boolean;
  refresh: () => void;
}

export function useMyPrs(): MyPrsResource {
  const [data, setData] = useState<MyPrsDto>();
  const [error, setError] = useState<CmdError>();
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const load = useCallback((force: boolean) => {
    setLoading(true);
    void ghMyPrs(force)
      .then((value) => {
        if (!mountedRef.current) return;
        setData(value);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (!mountedRef.current) return;
        setError(asCmdError(reason));
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void ghMyPrs(false)
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setError(asCmdError(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    let unlisten: (() => void) | undefined;
    void onOpenPrs((value) => {
      if (!alive) return;
      setData(value);
      setError(undefined);
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {
        /* 事件订阅失败不影响首屏缓存数据 */
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const refresh = useCallback(() => load(true), [load]);

  return { data, error, loading, refresh };
}

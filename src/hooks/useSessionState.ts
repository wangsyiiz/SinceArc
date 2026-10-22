import { useCallback, useEffect, useRef, useState } from "react";
import { messagesLoad } from "@/lib/ipc";
import { mergeMessages, minSeq } from "@/lib/messages-merge";
import { clog } from "@/lib/log";
import type { Message, SessionState } from "@/types";

export const emptySession = (): SessionState => ({
  msgs: [],
  acts: [],
  turns: [],
  busy: false,
  pendingPerm: null,
  locks: {},
});

export type PatchSession = (sid: string, fn: (s: SessionState) => SessionState) => void;

export interface PageState {
  hasMore: boolean;
  oldestSeq: number | null;
  loadingOlder: boolean;
}

export function useSessionState(lastSessionId: string) {
  const [sessionState, setSessionState] = useState<Record<string, SessionState>>({});
  const [pages, setPages] = useState<Record<string, PageState>>({});
  /** 同步读的分页状态：滚动回调连续触发时不能等 React 下一次渲染 */
  const pageRef = useRef<Record<string, PageState>>({});
  /** 每个会话已加载消息的 seq，翻页游标与合并排序都从这里取 */
  const seqBySession = useRef<Record<string, Record<string, number>>>({});

  const patchSession = useCallback((sid: string, fn: (s: SessionState) => SessionState) => {
    setSessionState((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? emptySession()) }));
  }, []);

  const setPageState = useCallback((sid: string, next: PageState) => {
    pageRef.current = { ...pageRef.current, [sid]: next };
    setPages((prev) => ({ ...prev, [sid]: next }));
  }, []);

  /**
   * 每次切到某个会话，都把**库里的历史**并进来。
   *
   * 以前这里有一句 `if (cur.msgs.length > 0) return prev`（「已经聊起来了，别覆盖」）：
   * 只要内存里已经有任意一条消息（上一次打开留下的旧快照、流式重放的残片都可能），
   * 再切回来就永远不再读库 —— 那之后写进库的内容（最后一条回答、在别处跑完的一轮）
   * 在界面上永远不出现。实测就是「第二个 session 的最后一条回复看不到」。
   *
   * 现在改成合并不是覆盖：
   * - 库里有的以库为准（它是权威历史）；
   * - 内存里**不在库里的**消息（正在流式、刚发出还没落库）保留并接在后面。
   */
  useEffect(() => {
    const sid = lastSessionId;
    if (!sid) return;
    let alive = true;
    (async () => {
      const page = await messagesLoad(sid).catch(() => null);
      if (!alive || page === null) return;

      const previousSeqs = seqBySession.current[sid] ?? {};
      const previousOldest = minSeq(previousSeqs);
      const firstSeq = page.messages[0]?.seq ?? null;
      // 已翻出更早页时，最新页的 hasMore 只说明「最新页之前还有」，
      // 不能覆盖更老游标上的真实状态。
      const olderAlreadyLoaded =
        previousOldest !== null && firstSeq !== null && previousOldest < firstSeq;
      const previousPage = pageRef.current[sid];
      const nextSeqs = { ...previousSeqs };
      for (const row of page.messages) nextSeqs[row.id] = row.seq;
      seqBySession.current[sid] = nextSeqs;
      const fromDb = page.messages.map((r) => r.payload as Message);

      setSessionState((prev) => {
        const cur = prev[sid] ?? emptySession();
        const merged = mergeMessages(cur.msgs, fromDb, nextSeqs);
        clog(
          "LOAD",
          `ui=${sid} page=${fromDb.length} total=${merged.length} before=${firstSeq ?? "-"}`,
        );
        return { ...prev, [sid]: { ...cur, msgs: merged } };
      });

      setPageState(sid, {
        hasMore: olderAlreadyLoaded
          ? (previousPage?.hasMore ?? page.hasMore)
          : page.hasMore,
        oldestSeq: minSeq(nextSeqs),
        loadingOlder: false,
      });
    })();
    return () => {
      alive = false;
    };
  }, [lastSessionId, setPageState]);

  const state = sessionState[lastSessionId] ?? emptySession();
  const currentPage = pages[lastSessionId];
  const hasMore = !!currentPage?.hasMore;
  const loadingOlder = !!currentPage?.loadingOlder;

  const loadOlder = useCallback(async () => {
    const sid = lastSessionId;
    if (!sid) return;
    const current = pageRef.current[sid];
    if (!current?.hasMore || current.loadingOlder) return;

    const beforeSeq = minSeq(seqBySession.current[sid] ?? {});
    if (beforeSeq === null) {
      setPageState(sid, { ...current, hasMore: false, loadingOlder: false });
      return;
    }

    setPageState(sid, { ...current, loadingOlder: true });
    const page = await messagesLoad(sid, { beforeSeq }).catch((e) => {
      clog("PAGE-ERR", `ui=${sid} before=${beforeSeq} ${String(e)}`);
      return null;
    });
    if (!page) {
      const latest = pageRef.current[sid] ?? current;
      setPageState(sid, { ...latest, loadingOlder: false });
      return;
    }

    const nextSeqs = { ...(seqBySession.current[sid] ?? {}) };
    for (const row of page.messages) nextSeqs[row.id] = row.seq;
    seqBySession.current[sid] = nextSeqs;
    const older = page.messages.map((r) => r.payload as Message);

    setSessionState((prev) => {
      const cur = prev[sid] ?? emptySession();
      const existing = new Set(cur.msgs.map((m) => m.id));
      // 全是重复 id 时保持原数组引用，避免触发「新消息滚到底」等副作用。
      if (!older.some((m) => !existing.has(m.id))) return prev;
      const merged = mergeMessages(cur.msgs, older, nextSeqs);
      clog(
        "PAGE",
        `ui=${sid} before=${beforeSeq} added=${older.length} total=${merged.length}`,
      );
      return { ...prev, [sid]: { ...cur, msgs: merged } };
    });

    setPageState(sid, {
      hasMore: page.hasMore,
      oldestSeq: minSeq(nextSeqs),
      loadingOlder: false,
    });
  }, [lastSessionId, setPageState]);

  const initSession = useCallback((id: string) => {
    setSessionState((prev) => ({ ...prev, [id]: emptySession() }));
  }, []);

  return {
    state,
    patchSession,
    initSession,
    sessionState,
    hasMore,
    loadOlder,
    loadingOlder,
  };
}

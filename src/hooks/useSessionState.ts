import { useCallback, useEffect, useState } from "react";
import { messagesLoad } from "@/lib/ipc";
import { isWrite } from "@/lib/format";
import { clog } from "@/lib/log";
import type { Message, SessionState } from "@/types";

export const emptySession = (): SessionState => ({
  msgs: [],
  acts: [],
  turns: [],
  busy: false,
  pendingPerm: null,
});

export type PatchSession = (sid: string, fn: (s: SessionState) => SessionState) => void;

export function useSessionState(lastSessionId: string) {
  const [sessionState, setSessionState] = useState<Record<string, SessionState>>({});

  const patchSession = useCallback((sid: string, fn: (s: SessionState) => SessionState) => {
    setSessionState((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? emptySession()) }));
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
      const rows = await messagesLoad(sid).catch(() => null);
      if (!alive || rows === null) return;
      const fromDb = rows.map((r) => r.payload as Message);
      setSessionState((prev) => {
        const cur = prev[sid] ?? emptySession();
        const inDb = new Set(fromDb.map((m) => m.id));
        const live = cur.msgs.filter((m) => !inDb.has(m.id));
        clog("LOAD", `ui=${sid} db=${fromDb.length} live=${live.length}`);
        return { ...prev, [sid]: { ...cur, msgs: [...fromDb, ...live] } };
      });
    })();
    return () => {
      alive = false;
    };
  }, [lastSessionId]);

  const state = sessionState[lastSessionId] ?? emptySession();
  const writeLock = state.acts.find((a) => a.status === "running" && isWrite(a)) ?? null;
  const initSession = useCallback((id: string) => {
    setSessionState((prev) => ({ ...prev, [id]: emptySession() }));
  }, []);

  return { state, patchSession, writeLock, initSession, sessionState };
}

import { useCallback, useEffect, useState } from "react";
import { messagesLoad } from "@/lib/ipc";
import { isWrite } from "@/lib/format";
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

  // 切到某个会话时把它最近的消息读回来（库里没有就什么都不做）
  useEffect(() => {
    const sid = lastSessionId;
    if (!sid) return;
    let alive = true;
    (async () => {
      const rows = await messagesLoad(sid).catch(() => []);
      if (!alive || rows.length === 0) return;
      setSessionState((prev) => {
        const cur = prev[sid] ?? emptySession();
        if (cur.msgs.length > 0) return prev; // 期间已经聊起来了，别覆盖
        return { ...prev, [sid]: { ...cur, msgs: rows.map((r) => r.payload as Message) } };
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

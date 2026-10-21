import { useCallback, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  asSessionUpdate,
  messagesAppend,
  sessionBindAcp,
  type AcpEvent,
  type ModesSnapshot,
} from "@/lib/ipc";
import { now } from "@/lib/format";
import { players } from "@/mock/data";
import type { SessionSummary } from "@/types";
import type { PatchSession } from "./useSessionState";

export interface AcpRefs {
  acpToUi: RefObject<Record<string, string>>;
  acpToTurn: RefObject<Record<string, string>>;
  activeAcp: RefObject<string>;
  streamText: RefObject<Record<string, string>>;
}

export function useAcpEvents({
  lastSessionId,
  patchSession,
  setSessions,
  onSessionBound,
  onAgentSwitch,
}: {
  lastSessionId: string;
  patchSession: PatchSession;
  /** 会话绑定 ACP session 后要回写列表（acpSessionId / profileId） */
  setSessions: Dispatch<SetStateAction<SessionSummary[]>>;
  /** 绑定完成后再推模式：这时后端才拿得到本次会话的 modes 快照 */
  onSessionBound?: (args: {
    profileId: string;
    acpSessionId: string;
    uiSessionId: string;
    snapshot: ModesSnapshot | null;
  }) => void;
  /** agent 自己切模式：只更新界面，不写存储 */
  onAgentSwitch?: (uiSessionId: string, modeId: string) => void;
}) {
  const [sessionsByProfile, setSessionsByProfile] = useState<Record<string, string>>({});
  const [eventCount, setEventCount] = useState(0);
  const [lastEvent, setLastEvent] = useState("");
  const [eventLog, setEventLog] = useState<{ at: number; text: string }[]>([]);
  const diag = useCallback((text: string) => {
    setEventLog((prev) => [...prev, { at: Date.now(), text: `· ${text}` }].slice(-80));
  }, []);

  // ACP sessionId -> UI 会话 id（mock 的 s-1 之类）。S3 阶段只有一个活跃会话，够用。
  const acpToUi = useRef<Record<string, string>>({});
  const streamBuf = useRef<Record<string, string>>({});
  /** 本轮已累积的完整回复（定稿时整条落库，不用再去 state 里翻） */
  const streamText = useRef<Record<string, string>>({});
  /** ACP 会话 -> 当前这一轮的 turn id（轨迹要跟着同一条轮次走） */
  const acpToTurn = useRef<Record<string, string>>({});
  /** 最近一次确认过的 ACP 会话 id：chunk 没带 sessionId 时的兜底 */
  const activeAcp = useRef("");
  const flushDiag = useRef(0);
  const flushTimer = useRef(0);
  const lastSidRef = useRef(lastSessionId);
  lastSidRef.current = lastSessionId;

  /** 40ms 合批：chunk 是逐字来的，逐条 setState 会让 React 每字重渲染一次 */
  const flushStream = useCallback(() => {
    flushTimer.current = 0;
    const buf = streamBuf.current;
    streamBuf.current = {};
    for (const [acpSid, text] of Object.entries(buf)) {
      // 映射缺失时退回当前会话：同一时刻只有一条 prompt 在跑，
      // 「这条流式内容属于我现在看的会话」这个判断不需要一张表也能成立。
      const mapped = acpToUi.current[acpSid];
      const uiSid = mapped ?? lastSidRef.current;
      if (!mapped) diag(`映射缺失，退回当前会话 ${uiSid}`);
      if (uiSid !== lastSidRef.current) {
        diag(`写入 ${uiSid}（当前看的是 ${lastSidRef.current}）`);
      }
      if (!text) continue;
      if (flushDiag.current < 12) {
        flushDiag.current += 1;
        diag(`flush -> ${uiSid} +${text.length} 字`);
      }
      const streamId = `stream-${acpSid}`;
      patchSession(uiSid, (s) => {
        const last = s.msgs[s.msgs.length - 1];
        const msgs =
          last && last.id === streamId && last.role === "player"
            ? [...s.msgs.slice(0, -1), { ...last, text: last.text + text }]
            : [
                ...s.msgs,
                {
                  id: streamId,
                  role: "player" as const,
                  playerId: players[0].id,
                  text,
                  at: now(),
                  streaming: true,
                },
              ];

        // 轨迹栏同步：这一轮的 running 分支跟着累积 reply
        const turnId = acpToTurn.current[acpSid];
        const turns = turnId
          ? s.turns.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    branches: t.branches.map((b) =>
                      b.status === "running" ? { ...b, reply: (b.reply ?? "") + text } : b,
                    ),
                  }
                : t,
            )
          : s.turns;

        return { ...s, msgs, turns };
      });
    }
  }, [diag, patchSession]);

  const onAgentEvent = useCallback(
    (profileId: string, event: AcpEvent) => {
      setEventCount((n) => n + 1);

      const su = asSessionUpdate(event);
      const kindLabel = su?.update?.sessionUpdate;
      // 正文片段：类型判错时也能看出内容到底在哪一类更新里
      const preview = su?.update?.content?.text?.slice(0, 40) ?? "";

      setEventLog((prev) =>
        [
          ...prev,
          {
            at: Date.now(),
            text:
              event.kind === "notification" || event.kind === "request"
                ? `${event.kind}:${event.method}${kindLabel ? ` / ${kindLabel}` : ""}${preview ? ` · ${preview}` : ""}`
                : event.kind,
          },
        ].slice(-80),
      );
      setLastEvent(
        event.kind === "notification"
          ? `${event.method}${kindLabel ? `/${kindLabel}` : ""}`
          : event.kind === "request"
            ? event.method
            : event.kind,
      );
      if (su?.update?.sessionUpdate === "current_mode_update") {
        const uiSid = acpToUi.current[su.sessionId ?? activeAcp.current];
        const modeId = su.update.currentModeId;
        if (uiSid && modeId) onAgentSwitch?.(uiSid, modeId);
        // 这条通知只是状态同步，没有正文，不能继续落进消息流
        return;
      }

      if (su?.update?.sessionUpdate === "agent_message_chunk") {
        const acpSid = su.sessionId || activeAcp.current;
        if (!su.sessionId) diag("chunk 缺 sessionId，回退到最近活跃会话");
        const text = su.update.content?.text ?? "";
        if (text) {
          streamBuf.current[acpSid] = (streamBuf.current[acpSid] ?? "") + text;
          streamText.current[acpSid] = (streamText.current[acpSid] ?? "") + text;
          if (!flushTimer.current) flushTimer.current = window.setTimeout(flushStream, 40);
        }
        return;
      }

      if (event.kind === "promptStarted") return;

      if (event.kind === "promptResult" || event.kind === "promptFailed") {
        flushStream();
        const uiSid = acpToUi.current[event.sessionId];
        diag(`promptResult -> ${uiSid ?? "无映射"}`);
        if (uiSid) {
          const streamId = `stream-${event.sessionId}`;
          const actId = `act-stream-${event.sessionId}`;
          const turnId = acpToTurn.current[event.sessionId];
          patchSession(uiSid, (s) => ({
            ...s,
            busy: false,
            acts: s.acts.map((a) =>
              a.id === actId
                ? { ...a, status: event.kind === "promptFailed" ? ("error" as const) : ("ok" as const) }
                : a,
            ),
            turns: turnId
              ? s.turns.map((t) =>
                  t.id === turnId
                    ? {
                        ...t,
                        branches: t.branches.map((b) => ({ ...b, status: "done" as const })),
                      }
                    : t,
                )
              : s.turns,
            msgs:
              event.kind === "promptFailed"
                ? [
                    ...s.msgs.map((m) =>
                      m.id === streamId && m.role === "player" ? { ...m, streaming: false } : m,
                    ),
                    {
                      id: `perr-${Date.now()}`,
                      role: "system" as const,
                      text: `这一轮失败：${event.msg}`,
                      at: now(),
                    },
                  ]
                : s.msgs.map((m) =>
                    m.id === streamId && m.role === "player" ? { ...m, streaming: false } : m,
                  ),
          }));
        }
        if (event.kind === "promptFailed") console.warn("[acp] prompt failed", event.msg);

        // 这一轮整条落库（同一 id 重复写是幂等的）
        const acpSid = event.sessionId;
        const full = streamText.current[acpSid] ?? "";
        delete streamText.current[acpSid];
        if (uiSid && full) {
          const id = `stream-${acpSid}`;
          messagesAppend(uiSid, [
            {
              id,
              role: "player",
              kind: "text",
              payload: {
                id,
                role: "player",
                playerId: players[0].id,
                text: full,
                at: now(),
                streaming: false,
              },
            },
          ]).catch((e) => console.warn("[db] append reply failed", e));
        }
        return;
      }

      console.debug("[acp]", profileId, event);
    },
    [flushStream, onAgentSwitch, patchSession],
  );

  const onSession = useCallback((profileId: string, sessionId: string, snapshot?: ModesSnapshot | null) => {
    setSessionsByProfile((m) => ({ ...m, [profileId]: sessionId }));
    // 建立映射：agent 回的事件带的是 ACP sessionId
    acpToUi.current[sessionId] = lastSidRef.current;
    activeAcp.current = sessionId;

    const uiId = lastSidRef.current;
    if (uiId) {
      sessionBindAcp(uiId, sessionId).catch((e) =>
        console.warn("[db] bind acp session failed", e),
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.id === uiId ? { ...s, acpSessionId: sessionId, profileId } : s,
        ),
      );
    }
    onSessionBound?.({
      profileId,
      acpSessionId: sessionId,
      uiSessionId: lastSidRef.current,
      snapshot: snapshot ?? null,
    });
  }, [onSessionBound, setSessions]);

  const acp = useMemo<AcpRefs>(() => ({ acpToUi, acpToTurn, activeAcp, streamText }), []);

  return { eventCount, lastEvent, eventLog, diag, sessionsByProfile, flushStream, onAgentEvent, onSession, acp };
}

import { useCallback, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  asSessionUpdate,
  messagesAppend,
  sessionBindAcp,
  type AcpEvent,
  type ModesSnapshot,
} from "@/lib/ipc";
import { denyPermission, parsePermissionOptions } from "@/hooks/usePermissions";
import { now } from "@/lib/format";
import { clog } from "@/lib/log";
import { pushSystemNotice } from "@/lib/notices";
import type { SessionSummary } from "@/types";
import { MAIN_AGENT_ID } from "./usePrompt";
import type { PatchSession } from "./useSessionState";

export interface AcpRefs {
  acpToUi: RefObject<Record<string, string>>;
  acpToTurn: RefObject<Record<string, string>>;
  /** ACP 会话 -> 该会话的发言者（agent user id）。主 agent 不在这张表里 */
  acpToAuthor: RefObject<Record<string, string>>;
  activeAcp: RefObject<string>;
  streamText: RefObject<Record<string, string>>;
}

export function useAcpEvents({
  lastSessionId,
  patchSession,
  setSessions,
  onSessionBound,
  onAgentSwitch,
  onPermission,
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
  /** agent 发来需要用户回答的请求（目前只有 session/request_permission） */
  onPermission?: (args: {
    uiSid: string;
    profileId: string;
    requestId: number;
    params: unknown;
  }) => void;
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
  /** ACP 会话 -> 发言的 agent user id（群成员的回答要记在它名下，docs/group-chat.md §4） */
  const acpToAuthor = useRef<Record<string, string>>({});
  const streamBuf = useRef<Record<string, string>>({});
  /** 本轮已累积的完整回复（定稿时整条落库，不用再去 state 里翻） */
  const streamText = useRef<Record<string, string>>({});
  /** ACP 会话 -> 当前这一轮的 turn id（轨迹要跟着同一条轮次走） */
  const acpToTurn = useRef<Record<string, string>>({});
  /** 最近一次确认过的 ACP 会话 id：chunk 没带 sessionId 时的兜底 */
  const activeAcp = useRef("");
  const flushDiag = useRef(0);

  /**
   * 每条回答必须有**自己的**消息 id。
   *
   * 以前是 `stream-${acpSid}`：同一个会话的每一条回答都用同一个 id，
   * 而落库是 `ON CONFLICT(id) DO UPDATE` —— 后一条直接把前一条覆盖掉。
   * 表现就是「前面几轮的 agent 回答凭空消失」（实测一个群 11 条消息只剩 1 条回答）。
   * 现在按「这一轮」生成 id，promptStarted 时清空，下一轮重新开一条。
   */
  const streamMsgId = useRef<Record<string, string>>({});
  const curStreamId = (acpSid: string) => {
    if (!streamMsgId.current[acpSid]) {
      streamMsgId.current[acpSid] = `stream-${acpSid}-${Date.now()}`;
    }
    return streamMsgId.current[acpSid];
  };
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
        clog("FLUSH", `acp=${acpSid} ui=${uiSid} +${text.length}`);
      }
      const streamId = curStreamId(acpSid);
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
                  // 成员的回答记在它名下；主 agent 的回答仍是默认玩家
                  playerId: acpToAuthor.current[acpSid] ?? MAIN_AGENT_ID,
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

      if (event.kind === "request" && event.method === "session/request_permission") {
        const params = (event.params ?? {}) as { sessionId?: unknown };
        const acpSid =
          typeof params.sessionId === "string" && params.sessionId
            ? params.sessionId
            : activeAcp.current;
        const uiSid = acpToUi.current[acpSid];
        if (!uiSid) {
          diag(`权限请求 #${event.id} 找不到会话映射（${acpSid || "无 sessionId"}），按拒绝作答`);
          // 丢弃不等于可以不管：没人回答 agent 会一直等。按拒绝收尾是最保守的选择。
          denyPermission(
            profileId,
            event.id,
            parsePermissionOptions(event.params),
          );
        } else {
          onPermission?.({
            uiSid,
            profileId,
            requestId: event.id,
            params: event.params,
          });
        }
        // 权限请求的 params 不是对话正文，不能继续落到消息/流式分支里。
        return;
      }

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

      if (event.kind === "promptStarted") {
        // 新一轮：上一轮的消息 id 作废，第一段 chunk 会开一条新消息
        delete streamMsgId.current[event.sessionId];
        delete streamText.current[event.sessionId];
        return;
      }

      if (event.kind === "promptResult" || event.kind === "promptFailed") {
        flushStream();
        // 与 flushStream 保持同一套兜底：映射缺失就落到当前会话。
        // 这里以前是硬取映射，取不到就整块跳过 —— 回答在界面里看得见、却一行都没落库。
        const mapped = acpToUi.current[event.sessionId];
        const uiSid = mapped ?? lastSidRef.current;
        if (!mapped) clog("RESULT-NOMAP", `acp=${event.sessionId} fallback=${uiSid}`);
        diag(`promptResult -> ${uiSid ?? "无映射"}`);
        if (uiSid) {
          const streamId = curStreamId(event.sessionId);
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
        if (event.kind === "promptFailed") {
          console.warn("[acp] prompt failed", event.msg);
          clog("FAIL", `acp=${event.sessionId} ui=${uiSid ?? "-"} ${event.msg}`);
          // 失败原因也要落库：否则恢复会话后就是「问了没人答」，看不出当时是失败
          if (uiSid) {
            const id = `perr-${Date.now()}`;
            messagesAppend(uiSid, [
              {
                id,
                role: "system",
                kind: "text",
                payload: { id, role: "system", text: `这一轮失败：${event.msg}`, at: now() },
              },
            ]).catch((e) => console.warn("[db] append failure notice failed", e));
          }
        }

        // 这一轮整条落库（同一 id 重复写是幂等的）
        const acpSid = event.sessionId;
        let full = streamText.current[acpSid] ?? "";
        delete streamText.current[acpSid];
        if (!full) {
          // 兜底：chunk 事件里的 sessionId 与 prompt 用的不一致时，
          // 文本会累积在另一个 key 下 —— 界面照样显示（flush 有兜底），
          // 但这里读 `acpSid` 会得到空串，于是**一行都不落库**。
          // 这条路径此前完全静默，正是「界面有回答、库里没有」最可能的成因。
          for (const [k, v] of Object.entries(streamText.current)) {
            if (!v || k === acpSid) continue;
            const kUi = acpToUi.current[k] ?? lastSidRef.current;
            if (kUi === uiSid) {
              full = v;
              delete streamText.current[k];
              clog("RESULT-ID-MISMATCH", `prompt=${acpSid} streamed=${k} ui=${uiSid} len=${v.length}`);
              break;
            }
          }
        }
        clog("RESULT", `acp=${acpSid} ui=${uiSid ?? "-"} kind=${event.kind} len=${full.length}`);
        if (uiSid && full) {
          const id = curStreamId(acpSid);
          messagesAppend(uiSid, [
            {
              id,
              role: "player",
              kind: "text",
              payload: {
                id,
                role: "player",
                playerId: acpToAuthor.current[acpSid] ?? MAIN_AGENT_ID,
                text: full,
                at: now(),
                streaming: false,
              },
            },
          ])
            .then(() => clog("DB-OK", `ui=${uiSid} id=${id} len=${full.length}`))
            .catch((e) => {
              console.warn("[db] append reply failed", e);
              clog("DB-ERR", `ui=${uiSid} id=${id} ${String(e)}`);
              // 写不进库必须让用户看见：否则他下次恢复会话又会以为「回答丢了」
              pushSystemNotice(patchSession, uiSid, `这条回答没能写入历史：${String(e)}`);
            });
        }
        // 这一轮结束：放掉 id，下一轮重新生成（否则下一轮还会覆盖这一条）
        delete streamMsgId.current[acpSid];
        return;
      }

      console.debug("[acp]", profileId, event);
    },
    [diag, flushStream, onAgentSwitch, onPermission, patchSession],
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

  const acp = useMemo<AcpRefs>(
    () => ({ acpToUi, acpToTurn, acpToAuthor, activeAcp, streamText }),
    [],
  );

  return { eventCount, lastEvent, eventLog, diag, sessionsByProfile, flushStream, onAgentEvent, onSession, acp };
}

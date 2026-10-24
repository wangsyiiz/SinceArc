import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { applyLock } from "@/lib/locks";
import { newId } from "@/lib/ids";
import { pushSystemNotice } from "@/lib/notices";
import type { UsageDto } from "@/lib/ipc/types.gen/UsageDto";
import type { SessionSummary } from "@/types";
import { MAIN_AGENT_ID } from "./usePrompt";
import type { PatchSession } from "./useSessionState";

/**
 * 事件归属的唯一来源是**后端**给的 `uiSessionId`。
 *
 * 这里曾经维护 `acpToUi`（ACP 会话 → 界面会话），映射缺失时「退回当前打开的会话」。
 * 那等于让「用户正在看哪一页」参与数据归属 —— 切一下会话，回答就写进另一个会话，
 * 界面上是「消息串了」，库里也跟着串。
 * 现在归属由后端的会话记录决定（含群成员身份），前端只做两件事：能投就投，投不了就丢弃并留痕。
 */
interface StreamState {
  uiSid: string;
  /** 谁说的话：群成员 id；主 agent 为 null */
  authorId: string | null;
  msgId: string;
  /** 已经推到界面上的文本 */
  text: string;
  /** 还没 flush 的片段 */
  buf: string;
}

function stopReasonOf(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("stopReason" in result)) return null;
  const value = (result as { stopReason?: unknown }).stopReason;
  return typeof value === "string" ? value : null;
}

/**
 * `session.lock` 是与 `AcpEvent` 并列的 topic 载荷。事件层现在会把 topic 一起交过来，
 * 所以按 topic 判断，不再靠「没有 kind 且带 count」这种形状约定去猜。
 */
interface SessionLockPayload {
  acpSessionId: string;
  uiSessionId: string | null;
  playerId: string | null;
  title: string;
  count: number;
}

function asSessionLock(event: unknown): SessionLockPayload | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Partial<Record<keyof SessionLockPayload, unknown>>;
  const count = value.count;
  const acpSessionId = value.acpSessionId;
  if (typeof count !== "number" || typeof acpSessionId !== "string") return null;
  return {
    acpSessionId,
    uiSessionId: typeof value.uiSessionId === "string" ? value.uiSessionId : null,
    playerId: typeof value.playerId === "string" ? value.playerId : null,
    title: typeof value.title === "string" ? value.title : "",
    count,
  };
}

function asUsage(event: unknown): UsageDto | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Partial<Record<keyof UsageDto, unknown>>;
  if (
    typeof value.used !== "number" ||
    typeof value.size !== "number" ||
    typeof value.percent !== "number"
  ) {
    return null;
  }
  return {
    uiSessionId: typeof value.uiSessionId === "string" ? value.uiSessionId : null,
    authorId: typeof value.authorId === "string" ? value.authorId : null,
    used: value.used,
    size: value.size,
    percent: value.percent,
  };
}

/** 主 agent 优先；没有主 agent 的报告时，取占用百分比最高的成员。 */
function pickUsage(byAuthor: Record<string, UsageDto>): UsageDto | null {
  const main = byAuthor[""];
  if (main) return main;
  let best: UsageDto | null = null;
  for (const value of Object.values(byAuthor)) {
    if (
      !best ||
      value.percent > best.percent ||
      (value.percent === best.percent && value.used > best.used)
    ) {
      best = value;
    }
  }
  return best;
}

export interface AcpRefs {
  /** ACP 会话 -> 当前这一轮的 turn id（轨迹栏用） */
  acpToTurn: React.RefObject<Record<string, string>>;
}

export function useAcpEvents({
  patchSession,
  setSessions,
  onSessionBound,
  onAgentSwitch,
  onPermission,
  onPermissionsExpired,
  onTraceChanged,
}: {
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
    authorId: string | null;
  }) => void;
  /** 轮终态/连接断开：队列里该会话的权限请求必须立刻标成过期 */
  onPermissionsExpired?: (args: {
    uiSid?: string;
    profileId: string;
    reason: string;
    /** 失效的成因：界面按它决定要不要顺带清掉本会话的自动同意档（别去比对中文文案） */
    cause: "turn-end" | "disconnected";
  }) => void;
  /** 轨迹变了（派活开始/结束这类不改 busy 的写入）：给 uiSessionId，未归属给 null */
  onTraceChanged?: (uiSessionId: string | null) => void;
}) {
  const [sessionsByProfile, setSessionsByProfile] = useState<Record<string, string>>({});
  const [eventCount, setEventCount] = useState(0);
  const [lastEvent, setLastEvent] = useState("");
  const [eventLog, setEventLog] = useState<{ at: number; text: string }[]>([]);
  const diag = useCallback((text: string) => {
    setEventLog((prev) => [...prev, { at: Date.now(), text: `· ${text}` }].slice(-80));
  }, []);

  /** ACP 会话 -> 这一轮的流式状态（每条回答一个独立 msgId，绝不重复使用） */
  const streams = useRef<Record<string, StreamState>>({});
  /** UI 会话 -> 作者 -> 最近一次 usage；主 agent 用空字符串作为键。 */
  const usageBySession = useRef<Record<string, Record<string, UsageDto>>>({});
  /**
   * 这个 ACP 会话当前有没有「我们自己发起的一轮」在跑。
   *
   * 为什么必须有：agent 在 `session/load` 之后会把上一轮**重放**一遍 ——
   * 那些 chunk 和真回答长得一模一样。以前它们会被当成新回答塞进界面（还会再落一次库），
   * 表现就是「历史里多出来一条」「切回会话看到刚说过的回答又冒出来」。
   * 现在只有 promptStarted 之后的 chunk 才算真回答，重放记 DROP-REPLAY。
   */
  const awaiting = useRef<Record<string, boolean>>({});
  const acpToTurn = useRef<Record<string, string>>({});
  const flushDiag = useRef(0);

  /** 40ms 合批：chunk 是逐字来的，逐条 setState 会让 React 每字重渲染一次 */
  const flushStream = useCallback(() => {
    for (const [acpSid, st] of Object.entries(streams.current)) {
      const text = st.buf;
      st.buf = "";
      if (!text) continue;
      st.text += text;
      if (flushDiag.current < 12) {
        flushDiag.current += 1;
        diag(`flush -> ${st.uiSid} +${text.length} 字`);
        clog("FLUSH", `acp=${acpSid} ui=${st.uiSid} +${text.length}`);
      }
      patchSession(st.uiSid, (s) => {
        const last = s.msgs[s.msgs.length - 1];
        const msgs =
          last && last.id === st.msgId && last.role === "player"
            ? [...s.msgs.slice(0, -1), { ...last, text: last.text + text }]
            : [
                ...s.msgs,
                {
                  id: st.msgId,
                  role: "player" as const,
                  playerId: st.authorId ?? MAIN_AGENT_ID,
                  text,
                  at: now(),
                  streaming: true,
                },
              ];

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

  /**
   * 不再自己攒 40ms：后端已经按 30ms / 4KB 合并过（src-tauri/src/coalesce.rs），
   * 这里每来一段就直接落到界面。前端再做一层定时器只会多一次拷贝和延迟。
   */
  const scheduleFlush = useCallback(() => {
    flushStream();
  }, [flushStream]);

  const onAgentEvent = useCallback(
    (profileId: string, event: AcpEvent, topic: string) => {
      setEventCount((n) => n + 1);

      // 进程没了 = 这个 profile 下次必须重新连接。停止/断开都会走到这里；
      // 不清映射的话，下一轮会复用已经死掉的 AgentProcess。
      if (topic === "conn.exited") {
        onPermissionsExpired?.({
          profileId,
          reason: "连接已断开",
          cause: "disconnected",
        });
        setSessionsByProfile((m) => {
          if (!(profileId in m)) return m;
          const next = { ...m };
          delete next[profileId];
          return next;
        });
        setEventLog((prev) => [...prev, { at: Date.now(), text: "conn.exited" }].slice(-80));
        setLastEvent("conn.exited");
        return;
      }

      // 进程树回收的观测行。只有 proc.warning（降级/可能残留）才弹一次性提示；
      // 正常回收只进诊断面板。
      if (topic === "proc.diag" || topic === "proc.warning") {
        const report = event as unknown as {
          message?: string;
          uiSessionId?: string | null;
        };
        const message = report.message ?? "process tree cleanup";
        setEventLog((prev) => [...prev, { at: Date.now(), text: message }].slice(-80));
        setLastEvent(topic);
        if (topic === "proc.warning") {
          const text = `进程树回收不完整，可能有残留：${message}`;
          if (report.uiSessionId) pushSystemNotice(patchSession, report.uiSessionId, text);
          else diag(text);
        }
        return;
      }

      // usage 只认 topic：形状兜底会让「带 used/size 的任意载荷」都被当成用量，
      // 这和上一轮 session.lock 靠载荷形状认事件是同一个错。
      // used/size 形状兜底一次（UsageDto 没有 AcpEvent 的 kind 字段）。
      const usageTopic = topic === "acp.usage";
      const usage = asUsage(event);
      if (usage && usageTopic) {
        setEventLog((prev) => [...prev, { at: Date.now(), text: "acp.usage" }].slice(-80));
        setLastEvent("acp.usage");
        if (!usage.uiSessionId) {
          clog("USAGE-NOUI", `author=${usage.authorId ?? "-"} used=${usage.used}`);
          return;
        }
        const byAuthor = (usageBySession.current[usage.uiSessionId] ??= {});
        byAuthor[usage.authorId ?? ""] = usage;
        const selected = pickUsage(byAuthor);
        patchSession(usage.uiSessionId, (s) => ({
          ...s,
          usage: selected
            ? {
                used: selected.used,
                size: selected.size,
                percent: selected.percent,
              }
            : null,
        }));
        return;
      }

      // 按 topic 判断，不再靠载荷形状猜
      if (topic === "session.trace") {
        // 派活开始/结束都不改 busy，靠这一下让轨迹面板重读（后端写完事件就敲）
        const uiSid = (event as { uiSessionId?: unknown })?.uiSessionId;
        onTraceChanged?.(typeof uiSid === "string" ? uiSid : null);
        return;
      }

      const sessionLock = topic === "session.lock" ? asSessionLock(event) : null;
      if (sessionLock) {
        setEventLog((prev) => [...prev, { at: Date.now(), text: "session.lock" }].slice(-80));
        setLastEvent("session.lock");
        if (!sessionLock.uiSessionId) {
          clog("LOCK-NOUI", `count=${sessionLock.count}`);
          return;
        }
        // 群聊里每个成员是独立 ACP 会话：按 acpSessionId 分开存，
        // 否则一个成员解锁会把另一个成员的提示一起清掉。
        patchSession(sessionLock.uiSessionId, (s) => ({
          ...s,
          locks: applyLock(s.locks ?? {}, sessionLock),
        }));
        return;
      }

      const su = asSessionUpdate(event);
      const kindLabel = su?.update?.sessionUpdate;
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

      // 归属只认后端填的字段；缺失就是「不属于任何界面会话」
      const uiSid: string | null = "uiSessionId" in event ? (event.uiSessionId ?? null) : null;
      const acpSid: string | null = "sessionId" in event ? (event.sessionId ?? null) : null;
      const authorId: string | null = "authorId" in event ? (event.authorId ?? null) : null;

      if (event.kind === "request" && event.method === "session/request_permission") {
        if (!uiSid) {
          diag(`权限请求 #${event.id} 没有归属会话（acp=${acpSid ?? "-"}），按拒绝作答`);
          clog("PERM-NOUI", `acp=${acpSid ?? "-"} id=${event.id}`);
          // 丢弃不等于可以不管：没人回答，agent 会一直等。按拒绝收尾最保守。
          denyPermission(profileId, event.id, parsePermissionOptions(event.params));
        } else {
          onPermission?.({
            uiSid,
            profileId,
            requestId: event.id,
            params: event.params,
            authorId,
          });
        }
        return;
      }

      if (su?.update?.sessionUpdate === "current_mode_update") {
        const modeId = su.update.currentModeId;
        if (uiSid && modeId) onAgentSwitch?.(uiSid, modeId);
        // 这条通知只是状态同步，没有正文
        return;
      }

      if (su?.update?.sessionUpdate === "agent_message_chunk") {
        const text = su.update.content?.text ?? "";
        if (!text) return;
        if (!acpSid || !uiSid) {
          // 不猜：宁可少显示一条，也不把回答写进别的会话
          clog("DROP-NOMAP", `acp=${acpSid ?? "-"} ui=- len=${text.length}`);
          return;
        }
        if (!awaiting.current[acpSid]) {
          // 没有我们发起的一轮：这是 session/load 之后的重放，数据库里已经有这条了
          clog("DROP-REPLAY", `acp=${acpSid} ui=${uiSid} len=${text.length}`);
          return;
        }
        const st = (streams.current[acpSid] ??= {
          uiSid,
          authorId,
          msgId: `stream-${acpSid}-${Date.now()}`,
          text: "",
          buf: "",
        });
        // 同一条 ACP 会话被另一个界面会话接手时，以最新一次投递为准
        if (st.uiSid !== uiSid) {
          clog("REBIND", `acp=${acpSid} ${st.uiSid} -> ${uiSid}`);
          st.uiSid = uiSid;
        }
        st.buf += text;
        scheduleFlush();
        return;
      }

      if (event.kind === "promptStarted") {
        if (!acpSid) return;
        awaiting.current[acpSid] = true;
        // 上一轮如果没收到 promptResult（进程崩了、连接断了），文本会留在这里。
        // 新一轮开始时先把它落库，别悄悄丢掉已经显示给用户的内容。
        const stale = streams.current[acpSid];
        if (stale && stale.text) {
          const id = stale.msgId;
          messagesAppend(stale.uiSid, [
            {
              id,
              role: "player",
              kind: "text",
              payload: {
                id,
                role: "player",
                playerId: stale.authorId ?? MAIN_AGENT_ID,
                text: stale.text,
                at: now(),
                streaming: false,
              },
            },
          ])
            .then(() => clog("SALVAGE", `ui=${stale.uiSid} id=${id} len=${stale.text.length}`))
            .catch((e) => console.warn("[db] salvage failed", e));
        }
        // 新一轮：上一轮的状态作废，第一段 chunk 会开一条新消息
        delete streams.current[acpSid];
        return;
      }

      if (event.kind === "promptResult" || event.kind === "promptFailed") {
        flushStream();
        if (!uiSid) {
          clog("RESULT-NOUI", `acp=${acpSid ?? "-"} kind=${event.kind}`);
          diag(`promptResult 无归属会话（acp=${acpSid ?? "-"}）`);
          if (acpSid) {
            delete streams.current[acpSid];
            delete awaiting.current[acpSid];
          }
          return;
        }
        // 轮已到终态：还没回答的权限请求不可能再生效。先置过期，再处理正文/状态。
        onPermissionsExpired?.({
          uiSid,
          profileId,
          reason: event.kind === "promptResult" ? "这一轮已结束" : "这一轮已失败",
          cause: "turn-end",
        });
        const st = acpSid ? streams.current[acpSid] : undefined;
        const actId = `act-stream-${acpSid ?? "x"}`;
        const turnId = acpSid ? acpToTurn.current[acpSid] : undefined;
        const failed = event.kind === "promptFailed";
        const stopReason = event.kind === "promptResult" ? stopReasonOf(event.result) : null;
        const cancelled = stopReason === "cancelled";

        patchSession(uiSid, (s) => ({
          ...s,
          busy: false,
          // 终态事件是 lossless 的；解锁事件可丢。这里兜底清掉，避免提示条残留。
          locks: {},
          acts: s.acts.map((a) =>
            a.id === actId
              ? {
                  ...a,
                  title: cancelled ? "已停止" : a.title,
                  status: failed ? ("error" as const) : ("ok" as const),
                }
              : a,
          ),
          turns: turnId
            ? s.turns.map((t) =>
                t.id === turnId
                  ? { ...t, branches: t.branches.map((b) => ({ ...b, status: "done" as const })) }
                  : t,
              )
            : s.turns,
          msgs: [
            ...s.msgs.map((m) =>
              st && m.id === st.msgId && m.role === "player"
                ? { ...m, streaming: false, stopped: cancelled || m.stopped }
                : m,
            ),
            ...(failed
              ? [
                  {
                    id: newId("perr"),
                    role: "system" as const,
                    text: `这一轮失败：${event.msg}`,
                    at: now(),
                  },
                ]
              : []),
          ],
        }));

        const full = st?.text ?? "";
        clog(
          "RESULT",
          `acp=${acpSid ?? "-"} ui=${uiSid} kind=${event.kind} stop=${stopReason ?? "-"} len=${full.length}`,
        );
        if (failed) {
          console.warn("[acp] prompt failed", event.msg);
          const id = newId("perr");
          messagesAppend(uiSid, [
            {
              id,
              role: "system",
              kind: "text",
              payload: { id, role: "system", text: `这一轮失败：${event.msg}`, at: now() },
            },
          ]).catch((e) => console.warn("[db] append failure notice failed", e));
        }
        if (full && st) {
          messagesAppend(uiSid, [
            {
              id: st.msgId,
              role: "player",
              kind: "text",
              payload: {
                id: st.msgId,
                role: "player",
                playerId: st.authorId ?? MAIN_AGENT_ID,
                text: full,
                at: now(),
                streaming: false,
              },
            },
          ])
            .then(() => clog("DB-OK", `ui=${uiSid} id=${st.msgId} len=${full.length}`))
            .catch((e) => {
              console.warn("[db] append reply failed", e);
              clog("DB-ERR", `ui=${uiSid} id=${st.msgId} ${String(e)}`);
              // 写不进库必须让用户看见，否则恢复会话时他只会以为回答丢了
              pushSystemNotice(patchSession, uiSid, `这条回答没能写入历史：${String(e)}`);
            });
        }
        if (acpSid) {
          delete streams.current[acpSid];
          delete awaiting.current[acpSid];
        }
        return;
      }

      console.debug("[acp]", profileId, event);
    },
    [
      diag,
      flushStream,
      onAgentSwitch,
      onPermission,
      onPermissionsExpired,
      onTraceChanged,
      patchSession,
      scheduleFlush,
    ],
  );

  const onSession = useCallback(
    (
      profileId: string,
      sessionId: string,
      snapshot?: ModesSnapshot | null,
      /**
       * 这次连接是为哪个界面会话发起的。**必须由调用方给出** ——
       * 后端据此把事件投到正确的会话，前端不再维护「acp → 界面会话」的映射。
       * 设置页给成员建会话时没有界面会话，不传即可（那条会话的事件不会投给任何人）。
       */
      uiSid?: string,
    ) => {
      setSessionsByProfile((m) => ({ ...m, [profileId]: sessionId }));
      if (!uiSid) {
        clog("BIND-NOUI", `acp=${sessionId} profile=${profileId}（没有界面会话）`);
        return;
      }
      sessionBindAcp(uiSid, sessionId).catch((e) =>
        console.warn("[db] bind acp session failed", e),
      );
      setSessions((prev) =>
        prev.map((s) => (s.id === uiSid ? { ...s, acpSessionId: sessionId, profileId } : s)),
      );
      onSessionBound?.({
        profileId,
        acpSessionId: sessionId,
        uiSessionId: uiSid,
        snapshot: snapshot ?? null,
      });
    },
    [onSessionBound, setSessions],
  );

  const acp = useMemo<AcpRefs>(() => ({ acpToTurn }), []);

  return {
    eventCount,
    lastEvent,
    eventLog,
    diag,
    sessionsByProfile,
    flushStream,
    onAgentEvent,
    onSession,
    acp,
  };
}

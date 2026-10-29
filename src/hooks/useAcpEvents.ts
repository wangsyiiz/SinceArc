import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
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
import { applyToolCallFields, reduceToolCall, type ToolCallState } from "@/lib/tool-call";
import {
  clearInFlight,
  listInFlight,
  reduceInFlight,
  type InFlightTool,
} from "@/lib/running-count";
import { newId } from "@/lib/ids";
import {
  LATE_SETTLE_QUIET_MS,
  LATE_WINDOW_MS,
  shouldAcceptChunk,
  shouldSettleLate,
} from "@/lib/late-window";
import { pushSystemNotice } from "@/lib/notices";
import { i18nText } from "@/lib/i18n-text";
import { asNoticeSeverity, type NoticeInput } from "@/lib/notice-inbox";
import { isAbsorbedSend, type SendTrace } from "@/lib/send-ack";
import { keyOf } from "@/lib/stream-key";
import { replaceTurnId, turnIdForPersist } from "@/lib/turn-id";
import type { CommandDto } from "@/lib/ipc/types.gen/CommandDto";
import type { UsageDto } from "@/lib/ipc/types.gen/UsageDto";
import type { Message, SessionSummary } from "@/types";
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
  acpSid: string;
  uiSid: string;
  messageId: string | null;
  /** 谁说的话：群成员 id；主 agent 为 null */
  authorId: string | null;
  /** 这条正文属于哪一轮；开流时从 turn 归属表快照，避免下一轮覆盖上一轮 */
  turnId: string | null;
  msgId: string;
  /** 已经推到界面上的文本 */
  text: string;
  /** 还没 flush 的片段 */
  buf: string;
  /** promptResult 之后迟到窗口里新建的流：需要自己 settle 落库 */
  late?: boolean;
}

interface AbsorbedCapture {
  uiSid: string;
  text: string;
  timer: number | null;
}

/** promptResult 可能先于最后一批合批正文到达；静默这么久再收口成 notice。 */
const ABSORBED_CAPTURE_QUIET_MS = 200;

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

interface AcpCommandsPayload {
  acpSessionId: string;
  commands: CommandDto[];
}

interface AsidePayload {
  sessionId: string;
  uiSessionId: string | null;
  text: string;
}

function asAside(event: unknown): AsidePayload | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Partial<Record<keyof AsidePayload, unknown>>;
  if (typeof value.sessionId !== "string" || typeof value.text !== "string") return null;
  return {
    sessionId: value.sessionId,
    uiSessionId: typeof value.uiSessionId === "string" ? value.uiSessionId : null,
    text: value.text,
  };
}

function asCommands(event: unknown): AcpCommandsPayload | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Partial<Record<keyof AcpCommandsPayload, unknown>>;
  if (typeof value.acpSessionId !== "string" || !value.acpSessionId) return null;
  if (!Array.isArray(value.commands)) return null;
  const commands: CommandDto[] = [];
  for (const raw of value.commands) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name.trim()) return null;
    const command: CommandDto = { name: item.name };
    if (typeof item.description === "string") command.description = item.description;
    if (typeof item.hint === "string") command.hint = item.hint;
    commands.push(command);
  }
  return {
    acpSessionId: value.acpSessionId,
    commands,
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
  /** ACP 会话 -> 本次 prompt 的兜底判定状态 */
  sendTraces: React.RefObject<Record<string, ActiveSendTrace>>;
}

export interface ActiveSendTrace extends SendTrace {
  uiSid: string;
  userMsg: Extract<Message, { role: "user" }>;
  /** 后端回执里的真实 turn id；拿到后替换本地占位 */
  turnId: string | null;
  userPersisted: boolean;
  absorbed: boolean;
}

export function useAcpEvents({
  patchSession,
  setSessions,
  onSessionBound,
  onAgentSwitch,
  onPermission,
  onPermissionsExpired,
  onTraceChanged,
  onNotice,
  onDisconnect,
  onSessionActivity,
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
    snapshot: { acpSessionId: string | null; turnId: string | null };
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
  /** 收到 ACP live notice；只进内存收件箱，不落库 */
  onNotice?: (uiSid: string, notice: NoticeInput) => void;
  /** 连接退出：调用方清空内存态的 notice 等 */
  onDisconnect?: () => void;
  /**
   * 该会话出现了「agent 还在干活」的活动事件（正文/思考/工具调用）。
   * 授权请求的惰性过期主判据靠它：等待授权期间 agent 完全阻塞，一旦又出活动就是那条授权已失效。
   */
  onSessionActivity?: (uiSid: string, acpSessionId: string) => void;
}) {
  const [sessionsByProfile, setSessionsByProfile] = useState<Record<string, string>>({});
  const [eventCount, setEventCount] = useState(0);
  const [lastEvent, setLastEvent] = useState("");
  const [eventLog, setEventLog] = useState<{ at: number; text: string }[]>([]);
  /** ACP 会话 id -> 最近一次命令列表；会话断开重连会覆盖。 */
  const [commandsByAcpSession, setCommandsByAcpSession] = useState<
    Record<string, CommandDto[]>
  >({});
  /** ACP 会话 -> 本轮正文是否已经出现过 messageId（插话门禁的一部分）。 */
  const [messageIdByAcpSession, setMessageIdByAcpSession] = useState<Record<string, boolean>>({});
  /** 界面会话 -> ACP 会话（来自事件归属，不依赖数据库列）。 */
  const [acpByUiSession, setAcpByUiSession] = useState<Record<string, string>>({});
  /** 同一份映射的同步镜像：新建会话后 send 要在同一次调用里立刻读到它。 */
  const acpByUiSessionRef = useRef<Record<string, string>>({});
  const noteAcpSession = useCallback((uiSid: string, acpSid: string) => {
    if (acpByUiSessionRef.current[uiSid] === acpSid) return;
    acpByUiSessionRef.current = { ...acpByUiSessionRef.current, [uiSid]: acpSid };
    setAcpByUiSession((prev) =>
      prev[uiSid] === acpSid ? prev : { ...prev, [uiSid]: acpSid },
    );
  }, []);
  const acpSessionForUi = useCallback(
    (uiSid: string) => acpByUiSessionRef.current[uiSid] ?? null,
    [],
  );
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
  /** ACP 会话 -> 迟到窗口截止时间（毫秒）。窗口内正文可能属于刚结束的一轮。 */
  const lateUntil = useRef<Record<string, number>>({});
  /** ACP 会话 -> 迟到流 settle 定时器。 */
  const lateTimers = useRef<Record<string, number>>({});
  /** ACP 会话 -> 最近一段迟到正文到达时间。 */
  const lateLastChunkAt = useRef<Record<string, number>>({});
  /** ACP 会话 -> 最近一次 tool_call 的合并状态（`tool_call_update` 是增量）。 */
  const toolCalls = useRef<Record<string, ToolCallState>>({});
  /** 判定为「被吞掉」后，继续接住迟到正文，避免它又变成 agent 气泡。 */
  const absorbedCaptures = useRef<Record<string, AbsorbedCapture>>({});
  /** 已收口后迟到的正文仍然丢弃，直到迟到窗口结束。 */
  const absorbedDone = useRef<Record<string, number>>({});
  /**
   * 状态栏「进行中」计数（docs/desktop-ux.md §26.2）。
   * 与 `toolCalls` 并存：那边只留最近一条画 §21 标签，这边按 toolCallId 去重计数。
   */
  const [inFlightTable, setInFlightTable] = useState<Record<string, InFlightTool>>({});
  const inFlightItems = useMemo(() => listInFlight(inFlightTable), [inFlightTable]);
  const clearInFlightFor = useCallback((acpSid: string) => {
    setInFlightTable((prev) => clearInFlight(prev, acpSid));
  }, []);
  const clearAllInFlight = useCallback(() => setInFlightTable({}), []);
  const acpToTurn = useRef<Record<string, string>>({});
  const sendTraces = useRef<Record<string, ActiveSendTrace>>({});
  const flushDiag = useRef(0);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(lateTimers.current)) window.clearTimeout(timer);
      for (const capture of Object.values(absorbedCaptures.current)) {
        if (capture.timer !== null) window.clearTimeout(capture.timer);
      }
      absorbedCaptures.current = {};
      absorbedDone.current = {};
    };
  }, []);

  /** 40ms 合批：chunk 是逐字来的，逐条 setState 会让 React 每字重渲染一次 */
  const flushStream = useCallback(() => {
    for (const [streamKey, st] of Object.entries(streams.current)) {
      const text = st.buf;
      st.buf = "";
      if (!text) continue;
      st.text += text;
      if (flushDiag.current < 12) {
        flushDiag.current += 1;
        diag(`flush -> ${st.uiSid} +${text.length} 字`); // i18n-ignore: diagnostic log
        clog("FLUSH", `acp=${st.acpSid} key=${streamKey} ui=${st.uiSid} +${text.length}`);
      }
      const turnId = acpToTurn.current[st.acpSid];
      const persistTurnId = turnIdForPersist(turnId);
      const messageTurnId = st.turnId ?? persistTurnId;
      if (messageTurnId && !st.turnId) st.turnId = messageTurnId;
      patchSession(st.uiSid, (s) => {
        const last = s.msgs[s.msgs.length - 1];
        const msgs =
          last && last.id === st.msgId && last.role === "player"
            ? [
                ...s.msgs.slice(0, -1),
                { ...last, text: last.text + text, turnId: last.turnId ?? messageTurnId },
              ]
            : [
                ...s.msgs,
                {
                  id: st.msgId,
                  role: "player" as const,
                  atomKind: "text.agent",
                  playerId: st.authorId ?? MAIN_AGENT_ID,
                  text,
                  at: now(),
                  streaming: true,
                  turnId: messageTurnId,
                },
              ];

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

  const clearLateTimer = useCallback((acpSid: string) => {
    const timer = lateTimers.current[acpSid];
    if (timer !== undefined) window.clearTimeout(timer);
    delete lateTimers.current[acpSid];
    delete lateLastChunkAt.current[acpSid];
  }, []);

  /** 把迟到流按 promptResult 的落库形状收尾；正常轮次不经过这里。 */
  const settleLateStream = useCallback(
    (acpSid: string, reason: "quiet" | "next-prompt") => {
      clearLateTimer(acpSid);
      const lateStreams = Object.entries(streams.current).filter(
        ([, st]) => st.acpSid === acpSid && st.late,
      );
      if (lateStreams.length === 0) {
        if (reason === "next-prompt") delete lateUntil.current[acpSid];
        return;
      }
      flushStream();
      if (reason === "next-prompt") delete lateUntil.current[acpSid];
      for (const [streamKey, st] of lateStreams) {
        const full = st.text;
        delete streams.current[streamKey];
        if (!full) continue;

        patchSession(st.uiSid, (s) => ({
          ...s,
          msgs: s.msgs.map((m) =>
            m.id === st.msgId && m.role === "player" ? { ...m, streaming: false } : m,
          ),
        }));
        messagesAppend(st.uiSid, [
          {
            id: st.msgId,
            role: "player",
            kind: "text",
            turnId: st.turnId ?? undefined,
            nonTurn: st.turnId == null,
            payload: {
              id: st.msgId,
              role: "player",
              playerId: st.authorId ?? MAIN_AGENT_ID,
              text: full,
              at: now(),
              streaming: false,
              ...(st.turnId ? { turnId: st.turnId } : {}),
            },
          },
        ])
          .then(() =>
            clog("LATE-DB", `ui=${st.uiSid} id=${st.msgId} len=${full.length} reason=${reason}`),
          )
          .catch((e) => {
            console.warn("[db] append late reply failed", e);
            clog("DB-ERR", `late ui=${st.uiSid} id=${st.msgId} ${String(e)}`);
            pushSystemNotice(
              patchSession,
              st.uiSid,
              i18nText("app.notice.historyWriteFailed", { msg: String(e) }),
            );
          });
      }
    },
    [clearLateTimer, flushStream, patchSession],
  );

  const scheduleLateSettle = useCallback(
    (acpSid: string) => {
      const previous = lateTimers.current[acpSid];
      if (previous !== undefined) window.clearTimeout(previous);
      lateLastChunkAt.current[acpSid] = Date.now();

      const arm = (delay: number) => {
        lateTimers.current[acpSid] = window.setTimeout(() => {
          delete lateTimers.current[acpSid];
          const lastChunkAt = lateLastChunkAt.current[acpSid] ?? 0;
          const current = Date.now();
          if (!shouldSettleLate(lastChunkAt, current)) {
            arm(Math.max(0, LATE_SETTLE_QUIET_MS - (current - lastChunkAt)));
            return;
          }
          settleLateStream(acpSid, "quiet");
        }, delay);
      };
      arm(LATE_SETTLE_QUIET_MS);
    },
    [settleLateStream],
  );

  const dropAbsorbedCapture = useCallback((acpSid: string) => {
    const capture = absorbedCaptures.current[acpSid];
    if (!capture) return;
    if (capture.timer !== null) window.clearTimeout(capture.timer);
    delete absorbedCaptures.current[acpSid];
  }, []);

  const finalizeAbsorbedCapture = useCallback(
    (acpSid: string) => {
      const capture = absorbedCaptures.current[acpSid];
      if (!capture) return;
      dropAbsorbedCapture(acpSid);
      // 收口后可能还有极短的一段合并正文在路上；继续丢掉，别让它变成气泡。
      absorbedDone.current[acpSid] = Date.now() + LATE_WINDOW_MS;
      const description = capture.text.trim();
      onNotice?.(capture.uiSid, {
        severity: "warning",
        title: i18nText("notice.absorbed.title"),
        ...(description ? { description } : {}),
      });
    },
    [dropAbsorbedCapture, onNotice],
  );

  const scheduleAbsorbedFinalize = useCallback(
    (acpSid: string) => {
      const capture = absorbedCaptures.current[acpSid];
      if (!capture) return;
      if (capture.timer !== null) window.clearTimeout(capture.timer);
      capture.timer = window.setTimeout(
        () => finalizeAbsorbedCapture(acpSid),
        ABSORBED_CAPTURE_QUIET_MS,
      );
    },
    [finalizeAbsorbedCapture],
  );

  const startAbsorbedCapture = useCallback(
    (acpSid: string, uiSid: string, text: string) => {
      dropAbsorbedCapture(acpSid);
      delete absorbedDone.current[acpSid];
      absorbedCaptures.current[acpSid] = { uiSid, text, timer: null };
      scheduleAbsorbedFinalize(acpSid);
    },
    [dropAbsorbedCapture, scheduleAbsorbedFinalize],
  );

  /** 返回 true 表示这段正文属于已判定被吞掉的发送，不能再开 agent 气泡。 */
  const appendAbsorbedText = useCallback(
    (acpSid: string, text: string) => {
      const capture = absorbedCaptures.current[acpSid];
      if (capture) {
        capture.text += text;
        scheduleAbsorbedFinalize(acpSid);
        return true;
      }
      const doneUntil = absorbedDone.current[acpSid];
      if (doneUntil === undefined) return false;
      if (Date.now() < doneUntil) return true;
      delete absorbedDone.current[acpSid];
      return false;
    },
    [scheduleAbsorbedFinalize],
  );

  const clearAbsorbedCaptures = useCallback(() => {
    for (const acpSid of Object.keys(absorbedCaptures.current)) {
      dropAbsorbedCapture(acpSid);
    }
    absorbedDone.current = {};
  }, [dropAbsorbedCapture]);

  const onAgentEvent = useCallback(
    (profileId: string, event: AcpEvent, topic: string) => {
      setEventCount((n) => n + 1);

      // 进程没了 = 这个 profile 下次必须重新连接。停止/断开都会走到这里；
      // 不清映射的话，下一轮会复用已经死掉的 AgentProcess。
      if (topic === "conn.exited") {
        clearAllInFlight();
        clearAbsorbedCaptures();
        sendTraces.current = {};
        onDisconnect?.();
        onPermissionsExpired?.({
          profileId,
          reason: i18nText("permission.expiredReason.disconnected"),
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
          const text = i18nText("app.notice.procWarning", { message });
          if (report.uiSessionId) pushSystemNotice(patchSession, report.uiSessionId, text);
          else diag(`进程树回收不完整，可能有残留：${message}`); // i18n-ignore: diagnostic log
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

      if (topic === "acp.commands") {
        const payload = asCommands(event);
        if (payload) {
          setEventLog((prev) => [...prev, { at: Date.now(), text: "acp.commands" }].slice(-80));
          setLastEvent("acp.commands");
          setCommandsByAcpSession((prev) => ({
            ...prev,
            [payload.acpSessionId]: payload.commands,
          }));
        }
        return;
      }

      if (topic === "acp.aside") {
        const aside = asAside(event);
        if (!aside?.uiSessionId) {
          clog("ASIDE-NOUI", `acp=${aside?.sessionId ?? "-"} len=${aside?.text.length ?? 0}`);
          return;
        }
        setEventLog((prev) => [...prev, { at: Date.now(), text: "acp.aside" }].slice(-80));
        setLastEvent("acp.aside");
        patchSession(aside.uiSessionId, (s) => {
          let index = -1;
          for (let i = s.msgs.length - 1; i >= 0; i -= 1) {
            const message = s.msgs[i];
            if (message.role === "user" && message.atomKind === "aside") {
              index = i;
              break;
            }
          }
          if (index < 0) return s;
          const msgs = [...s.msgs];
          const target = msgs[index];
          if (target.role === "user") {
            msgs[index] = {
              ...target,
              asideReceipt: `${target.asideReceipt ?? ""}${aside.text}`,
            };
          }
          return { ...s, msgs };
        });
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

      const observedUpdate = su?.update?.sessionUpdate;
      if (
        acpSid &&
        (observedUpdate === "agent_message_chunk" ||
          observedUpdate === "agent_thought_chunk" ||
          observedUpdate === "tool_call" ||
          observedUpdate === "tool_call_update")
      ) {
        const trace = sendTraces.current[acpSid];
        if (trace && trace.resolvedAt === null) trace.sawStream = true;
        // 未作答的授权请求遇到活动事件 = 已被 agent 丢掉（§29.4 主判据）
        if (uiSid && acpSid) onSessionActivity?.(uiSid, acpSid);
      }

      if (observedUpdate === "notice") {
        const update = su?.update as Record<string, unknown> | undefined;
        if (!uiSid) {
          clog("NOTICE-NOUI", `acp=${acpSid ?? "-"}`);
          return;
        }
        const title =
          typeof update?.title === "string" && update.title.trim()
            ? update.title
            : i18nText("notice.agent.title");
        const description =
          typeof update?.description === "string" && update.description.trim()
            ? update.description
            : undefined;
        onNotice?.(uiSid, {
          severity: asNoticeSeverity(update?.severity),
          title,
          ...(description ? { description } : {}),
        });
        return;
      }

      // 界面会话 → ACP 会话：事件自己带着这两样，不必等数据库那一列回填。
      // 新建会话的 `sessions.acp_session_id` 只在恢复路径落库，第一轮可能还是空的，
      // 而命令列表 / 能力面板 / 插话入口都挂在 ACP 会话上（见 docs/steering.md §5）。
      if (uiSid && acpSid) {
        noteAcpSession(uiSid, acpSid);
      }

      if (event.kind === "request" && event.method === "session/request_permission") {
        if (!uiSid) {
          diag(`权限请求 #${event.id} 没有归属会话（acp=${acpSid ?? "-"}），按拒绝作答`); // i18n-ignore: diagnostic log
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
            // 入队一瞬间的归属；拿不到就如实留 null，不能拿「当前激活会话」补。
            snapshot: {
              acpSessionId: acpSid ?? null,
              turnId: acpSid ? acpToTurn.current[acpSid] ?? null : null,
            },
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

      // 工具调用写进该 agent 自己的活动行（docs/desktop-ux.md §21.3）。
      // `tool_call_update` 是增量：null 不覆盖，沿用后端 merge_tool_call 的语义。
      // 终态（completed / failed）不重置行 —— 继续显示最后一次调用，直到下一次
      // tool_call 覆盖或这一轮收口；否则短工具连着跑时标签会来回跳。
      {
        const reduced = reduceToolCall(
          acpSid ? (toolCalls.current[acpSid] ?? null) : null,
          su?.update as Record<string, unknown> | undefined,
        );
        if (reduced) {
          if (acpSid && su?.update) {
            const update = su.update as Record<string, unknown>;
            setInFlightTable((prev) => reduceInFlight(prev, acpSid, update, Date.now()));
          }
          if (acpSid) toolCalls.current[acpSid] = reduced.nextState;
          const fields = reduced.fields;
          if (uiSid && acpSid && fields) {
            const actId = `act-stream-${acpSid}`;
            patchSession(uiSid, (s) => {
              const next = applyToolCallFields(s.acts, actId, fields);
              // 找不到该行（事件不属于当前界面会话 / 这一轮已收口）就不新建行
              return next ? { ...s, acts: next } : s;
            });
          }
          return;
        }
      }

      // 思考块和正文块用的是同一个 messageId 分配器：它们带 id 就足以证明
      // 「这个 agent 会给一段输出打 id」，插话回执正是靠这个区分（无需等正文首字）。
      if (su?.update?.sessionUpdate === "agent_thought_chunk") {
        const mid = su.update.messageId;
        if (acpSid && typeof mid === "string" && mid.trim()) {
          setMessageIdByAcpSession((prev) => (prev[acpSid] ? prev : { ...prev, [acpSid]: true }));
        }
        return;
      }

      if (su?.update?.sessionUpdate === "agent_message_chunk") {
        const text = su.update.content?.text ?? "";
        if (!text) return;
        if (acpSid && appendAbsorbedText(acpSid, text)) return;
        if (!acpSid || !uiSid) {
          // 不猜：宁可少显示一条，也不把回答写进别的会话
          clog("DROP-NOMAP", `acp=${acpSid ?? "-"} ui=- len=${text.length}`);
          return;
        }
        const inFlight = awaiting.current[acpSid] ?? false;
        const until = lateUntil.current[acpSid] ?? 0;
        if (!shouldAcceptChunk(inFlight, until, Date.now())) {
          // 既不在飞、也不在迟到窗口内：这是 session/load 之后的重放，数据库里已经有这条了
          clog("DROP-REPLAY", `acp=${acpSid} ui=${uiSid} len=${text.length}`);
          return;
        }
        const messageId =
          typeof su.update.messageId === "string" && su.update.messageId.trim()
            ? su.update.messageId.trim()
            : null;
        if (messageId) {
          setMessageIdByAcpSession((prev) =>
            prev[acpSid] ? prev : { ...prev, [acpSid]: true },
          );
        }
        const late = !inFlight;
        const hadLateStream = Object.values(streams.current).some(
          (stream) => stream.acpSid === acpSid && stream.late,
        );
        const streamKey = keyOf(acpSid, messageId);
        const st = (streams.current[streamKey] ??= {
          acpSid,
          uiSid,
          messageId,
          authorId,
          msgId: messageId ? streamKey : `stream-${acpSid}-${Date.now()}`,
          text: "",
          buf: "",
          turnId: turnIdForPersist(acpToTurn.current[acpSid]),
          late,
        });
        // 同一条 ACP 会话被另一个界面会话接手时，以最新一次投递为准
        if (st.uiSid !== uiSid) {
          clog("REBIND", `acp=${acpSid} ${st.uiSid} -> ${uiSid}`);
          st.uiSid = uiSid;
        }
        st.buf += text;
        scheduleFlush();
        if (late) {
          if (!hadLateStream) {
            clog("LATE-ACCEPT", `acp=${acpSid} ui=${uiSid} len=${text.length}`);
          }
          scheduleLateSettle(acpSid);
        }
        return;
      }

      if (event.kind === "promptStarted") {
        if (!acpSid) return;
        finalizeAbsorbedCapture(acpSid);
        // 新一轮的正文不能再被上一轮的「被吞」标记吃掉。
        delete absorbedDone.current[acpSid];
        // 事件里的 turnId 是首选；拿不到时保留本地占位，等 sessionPrompt 回执再替换。
        const eventTurnId = turnIdForPersist(event.turnId);
        if (eventTurnId) {
          const previous = acpToTurn.current[acpSid];
          acpToTurn.current[acpSid] = eventTurnId;
          if (uiSid && previous && previous !== eventTurnId) {
            patchSession(uiSid, (s) => ({
              ...s,
              turns: replaceTurnId(s.turns, previous, eventTurnId),
            }));
          }
        }
        // 新的一轮开始：把上一轮迟到窗口里还没收尾的正文先落库。
        settleLateStream(acpSid, "next-prompt");
        delete lateUntil.current[acpSid];
        awaiting.current[acpSid] = true;
        // 新一轮：上一条工具调用是上一轮的事，别让第一条 tool_call_update 继承它。
        delete toolCalls.current[acpSid];
        clearInFlightFor(acpSid);
        // 这里**不清** messageId 的证据：它说的是「这个 agent 会不会给正文分组」这个属性，
        // 不是「这一轮有没有分过组」。每轮清掉会让每轮开头几秒都判定成「不能插话」，
        // 而 hermes 是先想后写，正好整段时间都插不进去。
        // 上一轮如果没收到 promptResult（进程崩了、连接断了），文本会留在这里。
        // 新一轮开始时先把它落库，别悄悄丢掉已经显示给用户的内容。
        const staleStreams = Object.entries(streams.current).filter(
          ([, stream]) => stream.acpSid === acpSid,
        );
        for (const [streamKey, stale] of staleStreams) {
          delete streams.current[streamKey];
          if (!stale.text) continue;
          const id = stale.msgId;
          messagesAppend(stale.uiSid, [
            {
              id,
              role: "player",
              kind: "text",
              turnId: stale.turnId ?? undefined,
              nonTurn: stale.turnId == null,
              payload: {
                id,
                role: "player",
                playerId: stale.authorId ?? MAIN_AGENT_ID,
                text: stale.text,
                at: now(),
                streaming: false,
                ...(stale.turnId ? { turnId: stale.turnId } : {}),
              },
            },
          ])
            .then(() => clog("SALVAGE", `ui=${stale.uiSid} id=${id} len=${stale.text.length}`))
            .catch((e) => console.warn("[db] salvage failed", e));
        }
        // 新一轮：上一轮的状态作废，第一段 chunk 会开一条新消息
        return;
      }

      if (event.kind === "promptResult" || event.kind === "promptFailed") {
        const failed = event.kind === "promptFailed";
        const stopReason = event.kind === "promptResult" ? stopReasonOf(event.result) : null;
        if (acpSid) finalizeAbsorbedCapture(acpSid);
        const trace = acpSid ? sendTraces.current[acpSid] : undefined;
        if (trace) {
          trace.resolvedAt = Date.now();
          trace.stopReason = stopReason;
        }
        const absorbed = trace ? isAbsorbedSend(trace) : false;
        const absorbedTrace = absorbed ? trace : undefined;
        let absorbedText = "";
        const absorbedIds = new Set<string>();
        if (absorbedTrace && acpSid) {
          for (const [streamKey, stream] of Object.entries(streams.current)) {
            if (stream.acpSid !== acpSid) continue;
            absorbedText += stream.text + stream.buf;
            absorbedIds.add(stream.msgId);
            delete streams.current[streamKey];
          }
          absorbedTrace.absorbed = true;
        } else {
          flushStream();
        }
        if (acpSid) clearInFlightFor(acpSid);
        if (acpSid) lateUntil.current[acpSid] = Date.now() + LATE_WINDOW_MS;
        if (!uiSid) {
          clog("RESULT-NOUI", `acp=${acpSid ?? "-"} kind=${event.kind}`);
          diag(`promptResult 无归属会话（acp=${acpSid ?? "-"}）`); // i18n-ignore: diagnostic log
          if (acpSid) {
            for (const [streamKey, stream] of Object.entries(streams.current)) {
              if (stream.acpSid === acpSid) delete streams.current[streamKey];
            }
            delete awaiting.current[acpSid];
            delete sendTraces.current[acpSid];
          }
          return;
        }
        // 轮已到终态：还没回答的权限请求不可能再生效。先置过期，再处理正文/状态。
        onPermissionsExpired?.({
          uiSid,
          profileId,
          reason: i18nText(
            event.kind === "promptResult"
              ? "permission.expiredReason.turnEnded"
              : "permission.expiredReason.turnFailed",
          ),
          cause: "turn-end",
        });
        const streamsForTurn = acpSid
          ? Object.entries(streams.current).filter(([, stream]) => stream.acpSid === acpSid)
          : [];
        const streamingIds = new Set(streamsForTurn.map(([, stream]) => stream.msgId));
        const actId = `act-stream-${acpSid ?? "x"}`;
        const turnId = acpSid ? acpToTurn.current[acpSid] : undefined;
        const persistTurnId = turnIdForPersist(turnId);
        for (const [, stream] of streamsForTurn) {
          if (!stream.turnId && persistTurnId) stream.turnId = persistTurnId;
        }
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
                  title: cancelled ? i18nText("trace.status.stopped") : a.title,
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
            ...s.msgs
              .filter((m) => !(absorbedTrace && absorbedIds.has(m.id)))
              .map((m) => {
                if (absorbedTrace && m.id === absorbedTrace.userMsg.id && m.role === "user") {
                  return { ...m, undelivered: true };
                }
                return streamingIds.has(m.id) && m.role === "player"
                  ? {
                      ...m,
                      streaming: false,
                      stopped: cancelled || m.stopped,
                      // 出错与「用户点停止」在渲染层要区分：两者都当帧拉满，但只有停止会显示「已停止」。
                      failed: failed || m.failed,
                      ...(persistTurnId && !m.turnId ? { turnId: persistTurnId } : {}),
                    }
                  : m;
              }),
            ...(failed
              ? [
                  {
                    id: newId("perr"),
                    role: "system" as const,
                    atomKind: "notice.system",
                    text: i18nText("app.notice.turnFailed", { msg: event.msg }),
                    at: now(),
                    turnId: null,
                  },
                ]
              : []),
          ],
        }));

        if (absorbedTrace) {
          // 判定当下可能还没收到合批后的那句正文；先进入捕获窗口，
          // 200ms 内的迟到正文都转成同一条 notice，而不是 agent 气泡。
          startAbsorbedCapture(acpSid!, uiSid, absorbedText);
        }

        if (trace && !absorbed && !trace.userPersisted) {
          trace.userPersisted = true;
          const turnId = turnIdForPersist(
            acpSid ? acpToTurn.current[acpSid] ?? trace.turnId : trace.turnId,
          );
          if (turnId) trace.turnId = turnId;
          messagesAppend(uiSid, [
            {
              id: trace.userMsg.id,
              role: "user",
              kind: "text",
              payload: turnId ? { ...trace.userMsg, turnId } : trace.userMsg,
              ...(turnId ? { turnId } : { nonTurn: true }),
            },
          ]).catch((e) => console.warn("[db] append deferred user message failed", e));
        }

        const fullLength = streamsForTurn.reduce((sum, [, stream]) => sum + stream.text.length, 0);
        clog(
          "RESULT",
          `acp=${acpSid ?? "-"} ui=${uiSid} kind=${event.kind} stop=${stopReason ?? "-"} streams=${streamsForTurn.length} len=${fullLength}`,
        );
        if (failed) {
          console.warn("[acp] prompt failed", event.msg);
          const id = newId("perr");
          messagesAppend(uiSid, [
            {
              id,
              role: "system",
              kind: "text",
              payload: {
                id,
                role: "system",
                text: i18nText("app.notice.turnFailed", { msg: event.msg }),
                at: now(),
                turnId: null,
              },
              nonTurn: true,
            },
          ]).catch((e) => console.warn("[db] append failure notice failed", e));
        }
        void (async () => {
          for (const [, st] of streamsForTurn) {
            if (!st.text) continue;
            try {
              await messagesAppend(st.uiSid, [
                {
                  id: st.msgId,
                  role: "player",
                  kind: "text",
                  turnId: st.turnId ?? undefined,
                  nonTurn: st.turnId == null,
                  payload: {
                    id: st.msgId,
                    role: "player",
                    playerId: st.authorId ?? MAIN_AGENT_ID,
                    text: st.text,
                    at: now(),
                    streaming: false,
                    ...(st.turnId ? { turnId: st.turnId } : {}),
                  },
                },
              ]);
              clog("DB-OK", `ui=${st.uiSid} id=${st.msgId} len=${st.text.length}`);
            } catch (e) {
              console.warn("[db] append reply failed", e);
              clog("DB-ERR", `ui=${st.uiSid} id=${st.msgId} ${String(e)}`);
              // 写不进库必须让用户看见，否则恢复会话时他只会以为回答丢了
              pushSystemNotice(
                patchSession,
                st.uiSid,
                i18nText("app.notice.historyWriteFailed", { msg: String(e) }),
              );
            }
          }
        })();
        if (acpSid) {
          for (const [streamKey, stream] of streamsForTurn) {
            if (streams.current[streamKey] === stream) delete streams.current[streamKey];
          }
          delete awaiting.current[acpSid];
          delete sendTraces.current[acpSid];
        }
        return;
      }

      console.debug("[acp]", profileId, event);
    },
    [
      diag,
      flushStream,
      appendAbsorbedText,
      clearAbsorbedCaptures,
      finalizeAbsorbedCapture,
      onAgentSwitch,
      onPermission,
      onPermissionsExpired,
      onTraceChanged,
      onNotice,
      onDisconnect,
      patchSession,
      noteAcpSession,
      clearAllInFlight,
      clearInFlightFor,
      scheduleFlush,
      scheduleLateSettle,
      startAbsorbedCapture,
      settleLateStream,
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
        clog("BIND-NOUI", `acp=${sessionId} profile=${profileId}（没有界面会话）`); // i18n-ignore: diagnostic log
        return;
      }
      // 同步记一份：send 里 await ensureConnected 之后会立刻重新读 own。
      noteAcpSession(uiSid, sessionId);
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
    [noteAcpSession, onSessionBound, setSessions],
  );

  const acp = useMemo<AcpRefs>(() => ({ acpToTurn, sendTraces }), []);

  return {
    eventCount,
    lastEvent,
    eventLog,
    diag,
    sessionsByProfile,
    commandsByAcpSession,
    messageIdByAcpSession,
    acpByUiSession,
    inFlight: inFlightItems,
    clearInFlight: clearAllInFlight,
    acpSessionForUi,
    noteAcpSession,
    flushStream,
    onAgentEvent,
    onSession,
    acp,
  };
}

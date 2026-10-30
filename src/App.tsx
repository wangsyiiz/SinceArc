import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ActivityRail } from "@/components/ActivityRail";
import { Composer } from "@/components/Composer";
import { ConnectErrorState } from "@/components/ConnectErrorState";
import { EmptyState } from "@/components/EmptyState";
import { EmptyState as LoadingState } from "@/components/ui/EmptyState";
import { MessageItem } from "@/components/MessageItem";
import { NoticeStack } from "@/components/NoticeStack";
import { PermissionDialog } from "@/components/PermissionDialog";
import { PrView } from "@/components/PrView";
import { RepoBrowser } from "@/components/RepoBrowser";
import { ResizeHandles } from "@/components/ResizeHandles";
import { SettingsView } from "@/components/SettingsView";
import { AgentCapabilities } from "@/components/AgentCapabilities";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DelegateDialog } from "@/components/DelegateDialog";
import { MemberDetailPanel } from "@/components/MemberDetailPanel";
import { MAIN_AGENT_ID } from "@/hooks/usePrompt";
import { initI18n } from "@/i18n";
import { normalizeLanguage } from "@/i18n/normalize";
import { autoApproveCovered, type AutoApproveLevel } from "@/lib/auto-approve";
import { settingsKey } from "@/lib/settings-key";
import { normalizeCodeThemeId } from "@/lib/highlight/themes";
import { copyText } from "@/lib/clipboard";
import { profileLabel } from "@/lib/format";
import { i18nText, localizeText, translateKey } from "@/lib/i18n-text";
import { errorTextOf } from "@/lib/errors";
import { pushSystemNotice } from "@/lib/notices";
import { resolvePermissionTurn } from "@/lib/permission-timeout";
import { delegateCancelFailureKey, type DelegatePhase } from "@/lib/delegate-status";
import { acpSessionIdOfActivity } from "@/lib/activity-row";
import { mergeMessages } from "@/lib/messages-merge";
import { buildPlayers } from "@/lib/players";
import {
  REPLY_NOTIFY_COALESCE_MS,
  planReplyNotify,
  summarizeReply,
} from "@/lib/reply-notify";
import { steerGate, type SteerGate } from "@/lib/steer-availability";
import {
  dequeuePrompt,
  enqueuePrompt,
  queueCount,
  type QueuedPrompt,
} from "@/lib/busy-input";
import {
  dismissNotice,
  pushNotice,
  type NoticeInput,
  type UiNotice,
} from "@/lib/notice-inbox";
import { resolveAcpSessionId } from "@/lib/session-view";
import { Sidebar, type SidebarMode } from "@/components/Sidebar";
import { Splitter } from "@/components/Splitter";
import { StatusBar } from "@/components/StatusBar";
import { StorageNotice } from "@/components/StorageNotice";
import { TabStrip } from "@/components/TabStrip";
import { ThinkingRow } from "@/components/ThinkingRow";
import { TitleBar } from "@/components/TitleBar";
import { TracePanel } from "@/components/TracePanel";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  sessionStorageStats,
  sessionTrace,
  sessionTraceBackfill,
  type StorageStatsDto,
  type TraceBackfillDto,
  type TraceTurnDto,
} from "@/lib/ipc";
import { toTraceView } from "@/lib/trace-adapter";
import { describeUsage } from "@/lib/usage-format";
import { WorkspaceEmpty } from "@/components/WorkspaceEmpty";
import type {
  AgentProfile,
  GithubRepo,
  Message,
  PermissionRequest,
  Player,
  SessionSummary,
  Tab,
  ThreadSettings,
} from "@/types";
import { DEFAULT_THREAD_SETTINGS } from "@/types";
import {
  asCmdError,
  agentUsersList,
  delegateCancel,
  delegateTask,
  delegateWait,
  messageFromRow,
  messagesLoad,
  mentionResolve,
  permissionAllowTurn,
  permissionRevokeTurn,
  openExternal,
  settingsLoad,
  settingsSave,
  sessionDelete,
  sessionCancel,
  sessionMemberRemove,
  sessionMembers,
  sessionRebind,
  messagesAppend,
  sessionSteer,
  sessionUpsert,
  ghPrDetail,
  ghPrDiff,
  type AgentUser,
  type CmdError,
  type DiffPageDto,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type ModesSnapshot,
  type PrDetailDto,
  type PrDto,
  type RepoRefDto,
  type ResumeOutcome,
} from "@/lib/ipc";
import { now } from "@/lib/format";
import { clog } from "@/lib/log";
import { newId } from "@/lib/ids";
import { turnIdForPersist } from "@/lib/turn-id";
import { locateTargetOf } from "@/lib/turn-anchors";
import { normaliseTurnId } from "@/lib/turn-align";
import { useAcpEvents } from "@/hooks/useAcpEvents";
import { usePaneLayout } from "@/hooks/usePaneLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { useAgentConnect, type EnsureResult } from "@/hooks/useAgentConnect";
import { useDiscovery } from "@/hooks/useDiscovery";
import { useProfileStore } from "@/hooks/useProfileStore";
import { usePrompt } from "@/hooks/usePrompt";
import { useRepos } from "@/hooks/useRepos";
import { useGhRepo } from "@/hooks/useGhRepo";
import type { DiffPhase, GhPhase } from "@/lib/gh-repo-flow";
import { PR_STATE_LABEL } from "@/lib/pr-state";
import { useScrollFade } from "@/hooks/useScrollFade";
import { useSessionList } from "@/hooks/useSessionList";
import { useSessionState } from "@/hooks/useSessionState";
import { useSessionModes } from "@/hooks/useSessionModes";
import { useTabs } from "@/hooks/useTabs";
import { useTheme } from "@/hooks/useTheme";
import { estimateMessageHeight } from "@/lib/virtual/message-height";
import { useVirtualList } from "@/lib/virtual/useVirtualList";
import {
  forget,
  loadScroll,
  saveScroll,
  topVisibleRow,
  type ScrollAnchor,
} from "@/lib/view-state";
import {
  pinIndexes,
  WINDOW_EDGE,
  type WindowPlan,
} from "@/lib/messages-window";
import { useTrimAnchor, visibleIndexRange } from "@/lib/virtual/use-trim-anchor";

const SETTINGS_SAVE_DEBOUNCE_MS = 300;
/**
 * 轨迹面板一次拉取的轮数。服务端上限是 200 轮（事件 limit×200），但实测成本是线性的：
 * 50 轮 ≈ 1 万条活动、IPC 314 ms；200 轮 ≈ 4 万条、IPC 1213 ms、冷开面板 1574 ms。
 * 所以默认只拉 50 轮，翻更早交给「轨迹分页」那张卡（docs/desktop-ux.md §19.6）。
 */
const TRACE_TURN_LIMIT = 50;

interface TurnPolicy {
  profileId: string;
  acpSessionId: string;
  turnId: string;
  kinds: string[];
}

const REPLY_SOUND_URL = new URL("./assets/notify-reply.wav", import.meta.url).href;

let replyAudio: HTMLAudioElement | null = null;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 常驻一个 Audio 对象；自动播放被拦时只留诊断，不打扰用户。 */
function playReplySound(diag: (text: string) => void): void {
  try {
    replyAudio ??= new Audio(REPLY_SOUND_URL);
    replyAudio.currentTime = 0;
    void replyAudio.play().catch((error) => {
      diag(`REPLY-SOUND-FAIL ${describeError(error)}`);
    });
  } catch (error) {
    diag(`REPLY-SOUND-FAIL ${describeError(error)}`);
  }
}

/** 权限查询/请求与发送失败都静默降级为只发音频（§31.4）。 */
async function sendReplyNotification(
  title: string,
  body: string,
  diag: (text: string) => void,
): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) {
      diag("REPLY-TOAST-SKIP permission-denied");
      return;
    }
    await sendNotification({ title, body });
  } catch (error) {
    diag(`REPLY-TOAST-SKIP ${describeError(error)}`);
  }
}

interface SendInGroupOptions {
  /** 指定界面会话（后台队列续发）；不传就是当前打开的会话 */
  sid?: string;
  /** 用户发起时本轮已在跑：用于 400ms 兜底判定 */
  busyAtSend?: boolean;
  /** 从本地队列续发：不再进入忙碌分流 */
  fromQueue?: boolean;
}

export default function App() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ThreadSettings>(DEFAULT_THREAD_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const settingsSaveSeq = useRef(0);
  const settingsPendingKey = useRef<string | null>(null);
  /**
   * 只靠"值没变就不写"避免回环。键必须覆盖**所有**会落库的字段 ——
   * 漏一个的后果是它改了也不保存（写请求根本不发），而且只在重开后才露出来。
   */
  const savedSettings = useRef(settingsKey(DEFAULT_THREAD_SETTINGS));
  useTheme(settings.theme);
  // 语言跟着设置走：切换即时生效，不用重启（docs/i18n.md §2.3）。
  // 首帧由 main.tsx 按系统语言先初始化，落库值读回来之后覆盖它。
  useEffect(() => {
    initI18n(settings.language ?? normalizeLanguage(navigator.language));
  }, [settings.language]);
  useEffect(() => {
    document.documentElement.dataset.codeTheme = normalizeCodeThemeId(settings.codeTheme);
  }, [settings.codeTheme]);
  useScrollFade();
  const [mode, setMode] = useState<SidebarMode>("sessions");
  const [traceOpen, setTraceOpen] = useState(false);
  /**
   * 轨迹来自后端（session_events + turns），不再由前端从事件里推。
   * 拉取时机：打开面板、切换会话、以及一轮结束时（此时才刚有收尾状态）。
   */
  const [traceTurns, setTraceTurns] = useState<TraceTurnDto[]>([]);
  /** 当前会话的容量读数；气泡是否需要出现由后端 `over` 决定。 */
  const [storageStats, setStorageStats] = useState<StorageStatsDto | null>(null);
  const storageStatsSessionRef = useRef<string | null>(null);
  /** 派活这类「不改 busy 但改了轨迹」的写入靠它触发重读（后端写完事件敲 session.trace） */
  const [traceTick, setTraceTick] = useState(0);
  const [traceBackfill, setTraceBackfill] = useState<{
    sessionId: string | null;
    running: boolean;
    result: TraceBackfillDto | null;
    /** 命令失败时说人话的原因（50300 表示连接已断） */
    error: string | null;
  }>({ sessionId: null, running: false, result: null, error: null });
  const [focus, setFocus] = useState<{ id: string; tick: number } | null>(null);
  const [traceLocate, setTraceLocate] = useState<{ turnId: string; tick: number } | null>(null);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const [playerFilter, setPlayerFilter] = useState<string | null>(null);
  const [memberPanel, setMemberPanel] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [delegateTarget, setDelegateTarget] = useState<AgentUser | null>(null);
  const [permOpen, setPermOpen] = useState(false);
  const [autoApprove, setAutoApprove] = useState<Record<string, AutoApproveLevel>>({});
  /** 界面会话 → 当前轮的本轮同类放行策略（内存态，后端是权威来源） */
  const [turnPolicies, setTurnPolicies] = useState<Record<string, TurnPolicy>>({});
  const turnPoliciesRef = useRef(turnPolicies);
  useEffect(() => {
    turnPoliciesRef.current = turnPolicies;
  }, [turnPolicies]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleScrollAnchorRef = useRef<{
    uiSid: string;
    anchor: ScrollAnchor;
  } | null>(null);
  const lastScrollSaveAtRef = useRef(0);
  const restoredViewSessionRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const scrollAnchorRef = useRef<{
    sessionId: string;
    firstId: string | null;
  } | null>(null);
  /**
   * 底部浮层的实际高度。消息列表要留出这么多空间，否则最后一条会被输入框盖住 ——
   * 以前这里写死 `pb-32`（128px），输入框一高过 128px（多行输入、权限提示条、
   * 并行成本提示），最新那条回答就藏在浮层底下，看起来像「没有显示」。
   */
  const [composerH, setComposerH] = useState(128);
  /** 已发出取消请求、还在等 promptResult / promptFailed 的界面会话 */
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  /** handleId → 这次派活的界面阶段；终态后删掉，引用条不显示历史 */
  const [delegateRunning, setDelegateRunning] = useState<Record<string, DelegatePhase>>({});
  const [resumeBusy, setResumeBusy] = useState(false);


  useEffect(() => {
    if (!settingsLoaded) return;
    const key = settingsKey(settings);
    if (key === savedSettings.current && settingsPendingKey.current === null) return;
    const seq = ++settingsSaveSeq.current;
    settingsPendingKey.current = key;
    const timer = window.setTimeout(() => {
      settingsSave(settings)
        .then(() => {
          if (seq !== settingsSaveSeq.current) return;
          savedSettings.current = key;
          settingsPendingKey.current = null;
          setSettingsError(null);
        })
        .catch((e) => {
          if (seq !== settingsSaveSeq.current) return;
          settingsPendingKey.current = null;
          const err = asCmdError(e);
          setSettingsError(t("app.settings.saveFailed", { msg: errorTextOf(err, t) }));
        });
    }, SETTINGS_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [settings, settingsLoaded, t]);

  const { profiles, activeProfile, addProfile, updateProfile, removeProfile } = useProfileStore();
  const discovery = useDiscovery(profiles);
  /** 当前群的成员（docs/group-chat.md §1） */
  const [members, setMembers] = useState<AgentUser[]>([]);
  /** 全局 Agent User：当前成员被移出后，历史作者仍能从这里解析回身份。 */
  const [knownUsers, setKnownUsers] = useState<AgentUser[]>([]);
  /**
   * 主 agent 自己的身份（只用于渲染它说过的话）。
   * 不进左栏：左栏列的是群成员，主 agent 不是成员 —— 但它的回复也该有名字，
   * 否则界面上会显示成光秃秃的「agent」。
   */
  const mainAgentPlayer = useMemo<Player>(() => {
    const prof = activeProfile;
    return {
      id: MAIN_AGENT_ID,
      name: prof ? profileLabel(prof, t) : "agent",
      handle: "agent",
      color: "var(--i3)",
      profileId: prof?.id ?? "",
      busy: false,
    };
  }, [activeProfile, t]);

  const { sessions, setSessions, reload: reloadSessions } = useSessionList();
  const { tabs, activeTabId, setActiveTabId, activeTab, lastSessionId, setLastSessionId, openTab, closeTab, closeSessionTabs, selectTab, pinned, onPin, onUnpin } = useTabs(sessions);
  const {
    state,
    patchSession,
    initSession,
    sessionState,
    hasMore,
    loadOlder,
    loadingOlder,
    loadNewer,
    trimmedHead,
    trimmedTail,
    trimWindow,
    opening,
  } = useSessionState(lastSessionId);
  /** estimate/keyOf 的函数身份必须稳定，否则流式正文一更新就会作废整份测量缓存。 */
  const msgsRef = useRef(state.msgs);
  msgsRef.current = state.msgs;

  /** 当前界面会话的 live notice 收件箱；切会话/断连即清空。 */
  const [noticesBySession, setNoticesBySession] = useState<Record<string, UiNotice[]>>({});
  /** notice 是 live event：页面已经切走时，晚到的条目直接丢弃，切回去不能“复活”。 */
  const noticeSessionRef = useRef(lastSessionId);
  noticeSessionRef.current = lastSessionId;
  /** running 时排队的原文（仅内存，按界面会话分开）。 */
  const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedPrompt[]>>({});
  const queuedBySessionRef = useRef<Record<string, QueuedPrompt[]>>({});
  const [queueTick, setQueueTick] = useState(0);
  const flushingQueueRef = useRef<Set<string>>(new Set());
  /** 已发出 cancel、正在等本轮终态的界面会话。 */
  const [interrupting, setInterrupting] = useState<Record<string, boolean>>({});
  const sessionStateRef = useRef(sessionState);
  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  const pushUiNotice = useCallback((sid: string, notice: NoticeInput) => {
    if (!sid || sid !== noticeSessionRef.current) return;
    setNoticesBySession((prev) => ({
      ...prev,
      [sid]: pushNotice(prev[sid] ?? [], { ...notice, at: Date.now() }),
    }));
  }, []);
  const clearUiNotices = useCallback(() => setNoticesBySession({}), []);
  const dismissUiNotice = useCallback(
    (sid: string, id: string) => {
      setNoticesBySession((prev) => {
        if (!prev[sid]) return prev;
        return { ...prev, [sid]: dismissNotice(prev[sid] ?? [], id) };
      });
    },
    [],
  );

  const previousSessionId = useRef(lastSessionId);
  useEffect(() => {
    const previous = previousSessionId.current;
    if (previous === lastSessionId) return;
    previousSessionId.current = lastSessionId;
    if (previous) {
      // 「未发送」只活在这一页：离开时连同 notice 一起消失。
      patchSession(previous, (s) => ({
        ...s,
        msgs: s.msgs.filter(
          (message) => !(message.role === "user" && message.undelivered),
        ),
      }));
    }
    setNoticesBySession((prev) => {
      const next = { ...prev };
      delete next[previous];
      delete next[lastSessionId];
      return next;
    });
  }, [lastSessionId, patchSession]);

  /** 后台会话晚到的「未发送」结果也不该在切回去时出现。 */
  useEffect(() => {
    for (const [sid, session] of Object.entries(sessionState)) {
      if (sid === lastSessionId) continue;
      if (
        !session.msgs.some(
          (message) => message.role === "user" && message.undelivered,
        )
      ) {
        continue;
      }
      patchSession(sid, (s) => ({
        ...s,
        msgs: s.msgs.filter(
          (message) => !(message.role === "user" && message.undelivered),
        ),
      }));
    }
  }, [lastSessionId, patchSession, sessionState]);

  const messageKeyOf = useCallback(
    (index: number) => msgsRef.current[index]?.id ?? `message-index-${index}`,
    [],
  );
  const estimateMessage = useCallback(
    (index: number) => estimateMessageHeight(msgsRef.current[index]),
    [],
  );
  const {
    rows: virtualRows,
    totalSize: virtualTotalSize,
    measureRow,
    scrollToIndex: scrollToMessageIndex,
    scrollToEnd,
    forceScrollToEnd,
    atBottom: messageAtBottom,
    adjusting: messageAdjusting,
    beginProgrammaticScroll,
    beginAnchorShift,
    endAnchorShift,
    restoreAnchor,
    isAdjusting: isMessageAdjusting,
  } = useVirtualList({
    count: state.msgs.length,
    keyOf: messageKeyOf,
    estimate: estimateMessage,
    scrollRef,
    stickToBottom: true,
    scopeKey: activeTabId ?? lastSessionId,
    diag: clog,
  });

  const visibleMessageIds = useMemo(
    () => new Set(state.msgs.map((message) => message.id)),
    [state.msgs],
  );
  const pinnedMessageIndexes = useMemo(() => {
    const runningTurns = new Set<string>();
    for (const turn of state.turns) {
      if (turn.status !== "running") continue;
      const id = normaliseTurnId(turn.id);
      if (id) runningTurns.add(id);
    }
    const streaming: number[] = [];
    const undelivered: number[] = [];
    const runningTurn: number[] = [];
    state.msgs.forEach((message, index) => {
      if (message.role === "player" && message.streaming === true) streaming.push(index);
      if (message.role === "user" && message.undelivered === true) undelivered.push(index);
      const turnId = normaliseTurnId(message.turnId);
      if (turnId !== null && runningTurns.has(turnId)) runningTurn.push(index);
    });
    return pinIndexes({
      count: state.msgs.length,
      streaming,
      undelivered,
      runningTurn,
    });
  }, [state.msgs, state.turns]);

  const handleWindowTrim = useCallback(
    (plan: WindowPlan) => {
      if (!lastSessionId) return;
      trimWindow(lastSessionId, plan);
    },
    [lastSessionId, trimWindow],
  );
  useTrimAnchor({
    scrollRef,
    rows: virtualRows,
    count: state.msgs.length,
    scopeKey: activeTabId ?? lastSessionId,
    pinned: pinnedMessageIndexes,
    blocked: messageAdjusting,
    diag: clog,
    onProgrammaticScroll: beginProgrammaticScroll,
    onTrim: handleWindowTrim,
  });

  const restoreMessageScrollRef = useRef(restoreAnchor);
  restoreMessageScrollRef.current = restoreAnchor;

  useEffect(() => {
    const sid = lastSessionId;
    return () => {
      const live = visibleScrollAnchorRef.current;
      if (sid && live?.uiSid === sid) saveScroll(sid, live.anchor);
    };
  }, [activeTabId, lastSessionId]);

  useEffect(() => {
    restoredViewSessionRef.current = null;
  }, [activeTabId, lastSessionId]);

  useEffect(() => {
    const sid = lastSessionId;
    if (activeTab?.kind !== "session" || !sid || state.msgs.length === 0) return;
    if (restoredViewSessionRef.current === sid) return;
    restoredViewSessionRef.current = sid;
    const anchor = loadScroll(sid);
    restoreMessageScrollRef.current(anchor);
    if (anchor) visibleScrollAnchorRef.current = { uiSid: sid, anchor };
  }, [activeTab?.kind, activeTabId, lastSessionId, state.msgs.length]);

  // 打开会话时读一次；每轮结束（busy 收起、流式标记也已清掉）后再读一次。
  // 只读统计，不轮询、不写库。
  useEffect(() => {
    const sid = lastSessionId;
    if (!sid) {
      storageStatsSessionRef.current = null;
      setStorageStats(null);
      return;
    }
    if (storageStatsSessionRef.current !== sid) {
      storageStatsSessionRef.current = sid;
      setStorageStats(null);
    }
    if (state.busy || state.msgs.some((m) => m.role === "player" && m.streaming === true)) return;

    let alive = true;
    void sessionStorageStats(sid)
      .then((stats) => {
        if (alive && storageStatsSessionRef.current === sid) setStorageStats(stats);
      })
      .catch((e) => clog("STORAGE-STATS-ERR", String(e)));
    return () => {
      alive = false;
    };
  }, [lastSessionId, state.busy]);

  const authorIds = useMemo(() => {
    const ids: string[] = [];
    for (const message of state.msgs) {
      if (message.role === "player" && message.playerId !== MAIN_AGENT_ID) {
        ids.push(message.playerId);
      }
    }
    for (const activity of state.acts) {
      if (activity.playerId !== MAIN_AGENT_ID) ids.push(activity.playerId);
    }
    return ids;
  }, [state.msgs, state.acts]);

  /**
   * 玩家列表 = 当前成员 + 历史里出现过的作者。
   * 轨迹栏、@ 高亮、头像、权限弹窗全都按它取人，一处派生比到处塞 prop 更不容易漏。
   */
  const players = useMemo<Player[]>(
    () =>
      buildPlayers({ members, known: knownUsers, authorIds }).map((player) => ({
        ...player,
        busy: false,
      })),
    [members, knownUsers, authorIds],
  );

  /**
   * 渲染用的完整玩家表 = 群成员 + 主 agent。
   * 消息和思考行都必须用它：思考行的 playerId 对主 agent 是 `MAIN_AGENT_ID`，
   * 只在成员表里查会落空，之前的表现就是「发消息之后思考组件不出现」。
   */
  const renderPlayers = useMemo<Player[]>(
    () => [...players, mainAgentPlayer],
    [players, mainAgentPlayer],
  );

  /** 重新读当前群的成员：换群、加入、移出都走它 */
  const reloadMembers = useCallback(() => {
    agentUsersList()
      .then(setKnownUsers)
      .catch((e) => console.warn("[group] load known users failed", e));
    if (!lastSessionId) {
      setMembers([]);
      return;
    }
    sessionMembers(lastSessionId)
      .then(setMembers)
      .catch((e) => console.warn("[group] load members failed", e));
  }, [lastSessionId]);

  // 成员跟着「当前会话」走：换群就换一批人
  useEffect(() => {
    reloadMembers();
  }, [reloadMembers]);

  useEffect(() => {
    setMemberPanel(null);
    setDelegateTarget(null);
  }, [lastSessionId]);

  useEffect(() => {
    if (!memberPanel) return;
    if (members.some((m) => m.id === memberPanel.id)) return;
    setMemberPanel(null);
  }, [memberPanel, members]);

  const removeGroupMember = useCallback(
    async (member: AgentUser) => {
      if (!lastSessionId) return;
      await sessionMemberRemove(lastSessionId, member.id);
      if (playerFilter === member.id) setPlayerFilter(null);
      reloadMembers();
    },
    [lastSessionId, playerFilter, reloadMembers],
  );

  const { bySid: modesBySid, byProfile: modesByProfile, applyFor, choose, noteAgentSwitch } = useSessionModes();
  const onSessionBound = useCallback(
    (args: {
      profileId: string;
      acpSessionId: string;
      uiSessionId: string;
      snapshot: ModesSnapshot | null;
    }) => {
      void applyFor(args);
    },
    [applyFor],
  );
  const onAgentSwitch = useCallback(
    (uiSessionId: string, modeId: string) => noteAgentSwitch(uiSessionId, modeId),
    [noteAgentSwitch],
  );
  const onPermHead = useCallback(
    (uiSid: string, request: PermissionRequest | null) => {
      patchSession(uiSid, (s) => ({ ...s, pendingPerm: request }));
    },
    [patchSession],
  );
  const getAutoApprove = useCallback(
    // 会话内没有显式切过就用设置里的默认档（设置页「新会话默认自动同意」）
    (uiSid: string): AutoApproveLevel => autoApprove[uiSid] ?? settings.autoApproveDefault,
    [autoApprove, settings.autoApproveDefault],
  );
  const dropTurnPolicy = useCallback((uiSid: string) => {
    setTurnPolicies((prev) => {
      if (!(uiSid in prev)) return prev;
      const next = { ...prev };
      delete next[uiSid];
      return next;
    });
  }, []);
  const permissionDiagRef = useRef<(text: string) => void>(() => {});
  const permissionDiag = useCallback((text: string) => permissionDiagRef.current(text), []);
  const onPermissionTimeout = useCallback(
    (uiSid: string) => {
      pushUiNotice(uiSid, {
        severity: "warning",
        title: t("permission.expiredNotice.title"),
        description: t("permission.expiredNotice.description"),
      });
    },
    [pushUiNotice, t],
  );
  const permissions = usePermissions({
    onHead: onPermHead,
    getAutoApprove,
    diag: permissionDiag,
    onTimeout: onPermissionTimeout,
  });
  const onPermission = useCallback(
    (args: {
      uiSid: string;
      profileId: string;
      requestId: number;
      params: unknown;
      authorId: string | null;
      snapshot: { acpSessionId: string | null; turnId: string | null };
    }) => {
      void permissions.enqueue(
        args.uiSid,
        args.profileId,
        args.requestId,
        args.params,
        args.authorId,
        args.snapshot,
      );
    },
    [permissions.enqueue],
  );
  const onPermissionsExpired = useCallback(
    (args: {
      uiSid?: string;
      profileId: string;
      reason: string;
      cause: "turn-end" | "disconnected";
    }) => {
      permissions.expire(args);
      // 规范的时间边界：连接退出即结束本次授权，重连后回到默认关闭。
      if (args.cause === "disconnected") {
        setAutoApprove((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const session of sessions) {
            if (session.profileId === args.profileId && session.id in next) {
              delete next[session.id];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      setTurnPolicies((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [uiSid, policy] of Object.entries(prev)) {
          const hit =
            args.cause === "disconnected"
              ? policy.profileId === args.profileId
              : args.uiSid !== undefined && uiSid === args.uiSid;
          if (!hit) continue;
          delete next[uiSid];
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    [permissions.expire, sessions],
  );

  const tRef = useRef(t);
  const diagRef = useRef<(text: string) => void>(() => {});
  const settingsRef = useRef(settings);
  const lastSessionIdRef = useRef(lastSessionId);
  tRef.current = t;
  settingsRef.current = settings;
  lastSessionIdRef.current = lastSessionId;

  /** 音效节流 + 通知合并窗口；计时器在卸载时清掉。 */
  const replyNotifyRef = useRef({
    lastSoundAt: 0,
    lastSoundEventAt: 0,
    toastTimer: null as number | null,
    toastLastAt: 0,
    toastSessions: new Set<string>(),
    toastText: "",
  });
  useEffect(() => {
    return () => {
      if (replyNotifyRef.current.toastTimer !== null) {
        window.clearTimeout(replyNotifyRef.current.toastTimer);
      }
    };
  }, []);

  const onTurnFinished = useCallback(
    async (args: {
      uiSid: string;
      stopReason: string | null;
      outcome: "ok" | "failed";
      text: string;
    }) => {
      const finishedAt = Date.now();
      let windowFocused = false;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        windowFocused = await getCurrentWindow().isFocused();
      } catch (error) {
        diagRef.current(`REPLY-FOCUS-FAIL ${describeError(error)}`);
      }

      const current = settingsRef.current;
      const plan = planReplyNotify({
        soundEnabled: current.replySound,
        toastEnabled: current.replyToast,
        windowFocused,
        // 焦点查询是异步的：await 之后再读当前会话，避免用切换前的旧值做判断。
        viewingSession: args.uiSid === lastSessionIdRef.current,
        stopReason: args.stopReason,
        outcome: args.outcome,
      });

      if (plan.sound) {
        const at = Date.now();
        const pending = replyNotifyRef.current;
        if (
          finishedAt >= pending.lastSoundEventAt &&
          at - pending.lastSoundAt >= REPLY_NOTIFY_COALESCE_MS
        ) {
          pending.lastSoundEventAt = finishedAt;
          replyNotifyRef.current.lastSoundAt = at;
          playReplySound((text) => diagRef.current(text));
        }
      }

      if (!plan.toast) return;
      const pending = replyNotifyRef.current;
      pending.toastSessions.add(args.uiSid);
      // 焦点查询是异步的：旧事件可能晚于新事件返回，不能拿旧正文覆盖新正文。
      if (finishedAt >= pending.toastLastAt) {
        pending.toastLastAt = finishedAt;
        pending.toastText = args.text;
        if (pending.toastTimer !== null) window.clearTimeout(pending.toastTimer);
        pending.toastTimer = window.setTimeout(() => {
          const count = pending.toastSessions.size;
          const latestText = pending.toastText;
          pending.toastTimer = null;
          pending.toastSessions = new Set();
          pending.toastText = "";

          const title = tRef.current("replyNotify.title");
          const summary = summarizeReply(latestText);
          const completed =
            count > 1 ? tRef.current("replyNotify.sessionsDone", { count }) : "";
          const body = [completed, summary].filter(Boolean).join("\n");
          void sendReplyNotification(title, body, (text) => diagRef.current(text));
        }, REPLY_NOTIFY_COALESCE_MS);
      }
    },
    [],
  );

  const {
    eventCount,
    lastEvent,
    eventLog,
    diag,
    sessionsByProfile,
    commandsByAcpSession,
    messageIdByAcpSession,
    acpByUiSession,
    acpSessionForUi,
    noteAcpSession,
    onAgentEvent,
    onSession,
    acp,
    inFlight,
    clearInFlight,
  } = useAcpEvents({
    patchSession,
    setSessions,
    onSessionBound,
    onAgentSwitch,
    onPermission,
    onPermissionsExpired,
    onTraceChanged: () => setTraceTick((t) => t + 1),
    onNotice: pushUiNotice,
    onDisconnect: clearUiNotices,
    onTurnFinished,
    // §29.4 主判据：未作答的授权请求遇到该会话的新活动 = 已被 agent 丢掉
    onSessionActivity: (uiSid, acpSid) =>
      permissions.expireByActivity(
        uiSid,
        acpSid,
        i18nText("permission.expiredReason.agentTimeout"),
      ),
  });

  useEffect(() => {
    permissionDiagRef.current = diag;
    diagRef.current = diag;
  }, [diag]);

  // 切换会话时计数归零（§26.2 ③）；断开连接已在 hook 的 conn.exited 分支清空。
  useEffect(() => {
    clearInFlight();
  }, [lastSessionId, clearInFlight]);

  /** 恢复判定只有一个出口：错误态、诊断与会话头标记都从它更新。 */
  const reportResume = useCallback(
    (uiSid: string, outcome: ResumeOutcome, lastEventSeq: number | null) => {
      if (outcome.kind === "fresh") {
        patchSession(uiSid, (s) => ({ ...s, resume: null }));
        return;
      }
      if (outcome.kind === "resumed") {
        diag(
          `RESUME ok ui=${uiSid} acp=${outcome.acpSessionId}${outcome.note ? ` · ${outcome.note}` : ""}`,
        );
        patchSession(uiSid, (s) => ({
          ...s,
          resume: {
            kind: "resumed",
            acpSessionId: outcome.acpSessionId,
            note: outcome.note || undefined,
            lastEventSeq,
          },
        }));
        return;
      }
      diag(`RESUME unavailable ui=${uiSid} acp=${outcome.acpSessionId} · ${outcome.reason}`);
      patchSession(uiSid, (s) => ({
        ...s,
        resume: {
          kind: "unavailable",
          acpSessionId: outcome.acpSessionId,
          reason: outcome.reason,
          lastEventSeq,
        },
      }));
    },
    [diag, patchSession],
  );

  /* 设置读取放在 useAcpEvents 之后：脏值要推进它的事件流（诊断面板）。 */
  // 依赖必须是空数组：`t` 的标识随语言切换而变，若把它列进依赖，切语言会让这个 effect 重新
  // 读一次库、把刚改的 settings 覆盖回库里的旧值 —— 表现就是「点 English 又弹回中文」。
  // 需要最新 `t` / `diag` 的地方走 ref，effect 本身只跑一次。
  useEffect(() => {
    let alive = true;
    settingsLoad()
      .then((report) => {
        if (!alive) return;
        // 首启判定（docs/i18n.md §2.1）：库里没有 language（脏值也按「没有」处理）→ 按系统语言归一化；
        // 判定结果交给保存副作用写库 —— savedSettings 用读回来的原值，键变了才会触发那一次保存。
        const language = report.settings.language ?? normalizeLanguage(navigator.language);
        savedSettings.current = settingsKey(report.settings);
        setSettings({ ...report.settings, language });
        // 脏值不许静默：后端已经写了日志，这里再推进诊断面板，让用户当场看得见
        report.issues.forEach((issue) => diagRef.current(issue));
      })
      .catch((e) => {
        if (!alive) return;
        const err = asCmdError(e);
        setSettingsError(localizeText(err.msg, tRef.current));
      })
      .finally(() => {
        if (alive) setSettingsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const activeSession = sessions.find((s) => s.id === lastSessionId);
  // 归属跟会话走，不再跟一个全局「选中连接」走：全局选中项的唯一入口（左下角列表）
  // 已经移除，靠它就等于靠一个永远空着的值
  const sessionProfile = profiles.find((p) => p.id === activeSession?.profileId) ?? activeProfile;
  /** 进行中明细按 ACP 会话找成员；主 agent 没有成员记录，用当前会话连接的名字。 */
  const runningItems = useMemo(
    () =>
      inFlight.map((item) => {
        const member = members.find((m) => m.acpSessionId === item.acpSessionId);
        const player = member
          ? renderPlayers.find((candidate) => candidate.id === member.id)
          : undefined;
        return {
          name: localizeText(player?.name ?? member?.name ?? mainAgentPlayer.name, t),
          title: localizeText(item.title, t),
          startedAt: item.startedAt,
        };
      }),
    [inFlight, mainAgentPlayer.name, members, renderPlayers, t],
  );

  // 命令属于 ACP 会话，不属于 UI 会话：没有 acpSessionId 就不传，块不出现。
  /**
   * **唯一的会话解析口**（docs/data-plane.md §2）：界面只持有 uiSessionId，其余 id 由它派生。
   * 顺序：会话记录 → 事件流学到的映射 → null（不猜「连接当前会话」）。
   */
  const acpSessionOf = useCallback(
    (uiSid: string) =>
      resolveAcpSessionId(
        sessions.find((s) => s.id === uiSid)?.acpSessionId,
        acpSessionForUi(uiSid),
        acpByUiSession[uiSid],
      ),
    [sessions, acpByUiSession, acpSessionForUi],
  );
  /**
   * 活动会话的 ACP 会话 id。状态栏、模式切换、停止、能力面板、命令列表、插话门禁
   * 全部只认这一个值 —— 少一处读「连接当前会话」就是切换数据面不完整。
   */
  const activeAcpSid = acpSessionOf(lastSessionId);
  const acpCommands = activeAcpSid ? commandsByAcpSession[activeAcpSid] : undefined;
  /** 插话入口的三态：off=这个 agent 没声明 steer；waiting=声明了但还没见过正文分组；on=可插 */
  const steerMode: SteerGate = steerGate(
    acpCommands,
    activeAcpSid ? !!messageIdByAcpSession[activeAcpSid] : false,
  );
  const isStopping = !!cancelling[lastSessionId] && state.busy;
  const isInterrupting = !!interrupting[lastSessionId];
  const activeTurnId = activeAcpSid ? acp.acpToTurn.current[activeAcpSid] ?? null : null;
  const activeTurnPolicy = (() => {
    const policy = lastSessionId ? turnPolicies[lastSessionId] : undefined;
    if (!policy || !state.busy) return undefined;
    return policy.acpSessionId === activeAcpSid && policy.turnId === activeTurnId
      ? policy
      : undefined;
  })();
  const pendingTurnPolicyKind =
    state.pendingPerm?.kind && activeTurnPolicy?.kinds.includes(state.pendingPerm.kind)
      ? state.pendingPerm.kind
      : null;

  const allowTurnPolicy = useCallback(async () => {
    const request = state.pendingPerm;
    if (!request?.kind) throw { code: 50300, msg: t("app.permission.allowTurn.noKind") };
    // 请求入队时的归属优先。只要快照有任何一项，就整组使用快照，
    // 不用当前激活 tab 去补缺 —— 否则会把别的会话的 turn 配给这条请求。
    const liveTurn = {
      profileId: activeSession?.profileId ?? sessionProfile?.id,
      acpSessionId: activeAcpSid,
      turnId: activeAcpSid ? acp.acpToTurn.current[activeAcpSid] : undefined,
    };
    const { profileId, acpSessionId, turnId } = resolvePermissionTurn(request, liveTurn);
    if (!lastSessionId || !profileId || !acpSessionId || !turnId) {
      throw { msg: t("permission.expiredReason.unknownTurn") };
    }
    await permissionAllowTurn(profileId, acpSessionId, turnId, request.kind);
    const kind = request.kind;
    setTurnPolicies((prev) => {
      const current = prev[lastSessionId];
      const sameTurn =
        current?.acpSessionId === acpSessionId && current.turnId === turnId;
      const kinds = sameTurn
        ? Array.from(new Set([...current.kinds, kind]))
        : [kind];
      return {
        ...prev,
        [lastSessionId]: { profileId, acpSessionId, turnId, kinds },
      };
    });
  }, [acp, activeAcpSid, activeSession?.profileId, lastSessionId, sessionProfile?.id, state.pendingPerm, t]);

  const revokeTurnPolicy = useCallback(async () => {
    const policy = lastSessionId ? turnPoliciesRef.current[lastSessionId] : undefined;
    if (!policy) return;
    try {
      const removed = await permissionRevokeTurn(
        policy.profileId,
        policy.acpSessionId,
        policy.turnId,
      );
      // false = 后端本来就没有这条策略；界面同样以「不再放行」为准。
      dropTurnPolicy(lastSessionId);
      if (!removed) diag(`TURN-POLICY revoke found nothing ui=${lastSessionId}`);
    } catch (e) {
      const message = localizeText((e as { msg?: string })?.msg ?? String(e), t);
      diag(`TURN-POLICY revoke failed ui=${lastSessionId} · ${message}`);
      clog("TURN-POLICY-REVOKE-ERR", `ui=${lastSessionId} ${message}`);
    }
  }, [diag, dropTurnPolicy, lastSessionId, t]);

  // 换会话即失效：不把上一页的授权带到新页面，也通知后端撤销。
  const prevPolicyUiRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPolicyUiRef.current;
    prevPolicyUiRef.current = lastSessionId || null;
    if (!prev || prev === lastSessionId) return;
    const policy = turnPoliciesRef.current[prev];
    if (!policy) return;
    dropTurnPolicy(prev);
    void permissionRevokeTurn(policy.profileId, policy.acpSessionId, policy.turnId).catch((e) => {
      const message = localizeText((e as { msg?: string })?.msg ?? String(e), t);
      diag(`TURN-POLICY revoke on switch failed ui=${prev} · ${message}`);
    });
  }, [diag, dropTurnPolicy, lastSessionId, t]);

  // 轮终态/换轮后后端已清；界面必须同步收起 chip，不能在下一轮继续显示。
  useEffect(() => {
    if (!lastSessionId) return;
    const policy = turnPoliciesRef.current[lastSessionId];
    if (!policy) return;
    if (!state.busy || policy.acpSessionId !== activeAcpSid || policy.turnId !== activeTurnId) {
      dropTurnPolicy(lastSessionId);
    }
  }, [activeAcpSid, activeTurnId, dropTurnPolicy, lastSessionId, state.busy]);

  const usageLine = state.usage ? describeUsage(state.usage, t) : null;
  const connectProblem: {
    code?: string;
    message: string;
    key?: string;
    params?: Record<string, string>;
  } | null = state.connectError
    ? {
        code: state.connectError.code,
        message: state.connectError.message,
        key: state.connectError.key,
        params: state.connectError.params,
      }
    : state.resume?.kind === "unavailable"
      ? { message: state.resume.reason ?? t("app.unknownReason") }
      : null;

  useEffect(() => {
    if (state.busy) return;
    setCancelling((prev) =>
      prev[lastSessionId] ? { ...prev, [lastSessionId]: false } : prev,
    );
  }, [state.busy, lastSessionId]);

  // 连接生命周期只有这一处实现：设置页手动连接、打开会话自动连接都走它
  const { connect, ensureConnected, disconnect } = useAgentConnect({
    profiles,
    sessionsByProfile,
    onUpdateProfile: updateProfile,
    onAgentEvent,
    onSession,
  });
  const profileIdOf = useCallback(
    (uiSid: string) => sessions.find((s) => s.id === uiSid)?.profileId ?? null,
    [sessions],
  );
  const cwdOf = useCallback(
    (uiSid: string, profileId: string | null) => {
      const sessionCwd = sessions.find((s) => s.id === uiSid)?.cwd;
      if (sessionCwd) return sessionCwd;
      return profiles.find((p) => p.id === profileId)?.cwd ?? "";
    },
    [profiles, sessions],
  );
  const onAcpSessionCreated = useCallback(
    (uiSid: string, profileId: string, acpSid: string, modes: ModesSnapshot | null) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === uiSid ? { ...s, acpSessionId: acpSid, profileId } : s,
        ),
      );
      noteAcpSession(uiSid, acpSid);
      // 建会话时就带上 agent 报的模式快照：不带，界面这条会话永远显示「不支持」。
      onSessionBound({
        profileId,
        acpSessionId: acpSid,
        uiSessionId: uiSid,
        snapshot: modes,
      });
    },
    [noteAcpSession, onSessionBound, setSessions],
  );
  const { send } = usePrompt({
    lastSessionId,
    patchSession,
    activeProfile: sessionProfile,
    sessionsByProfile,
    acpSessionOf,
    cwdOf,
    onSessionCreated: onAcpSessionCreated,
    contextMessages: settings.contextMessages,
    acp,
    profileIdOf,
    ensureConnected,
    onResume: reportResume,
  });
  const { sidebarW, setSidebarW, traceW, setTraceW, dragging, setDragging, layoutRef, mainMin, sidebarMax, traceMax } = usePaneLayout(traceOpen);
  const { repoList, addRepo, addFromGh, pin, activeRepo } = useRepos(activeTab);

  /**
   * gh 三态的权威存储在 App：按 repoId 记住 phase，切走再切回不重闪骨架。
   * `prsByRepo` 单独存列表，供侧栏计数（侧栏不需要 identity 之外的东西）。
   */
  const [ghPhases, setGhPhases] = useState<Record<string, GhPhase>>({});
  const [prsByRepo, setPrsByRepo] = useState<Record<string, PrDto[]>>({});
  /** PR 详情缓存：`repoId:number` → 详情或错误。 */
  const [prDetails, setPrDetails] = useState<
    Record<string, { detail?: PrDetailDto; error?: CmdError }>
  >({});
  /** diff 每页缓存（键 = `repoId:number:page`）与失败。 */
  const [diffPages, setDiffPages] = useState<Record<string, DiffPageDto>>({});
  const [diffErrors, setDiffErrors] = useState<Record<string, CmdError>>({});
  const [diffPageByPr, setDiffPageByPr] = useState<Record<string, number>>({});
  /** 自增 → 侧栏展开添加项目输入框（代码视图「重新选择目录」）。 */
  const [addRepoSignal, setAddRepoSignal] = useState(0);

  const cwd = activeSession?.cwd ?? sessionProfile?.cwd ?? "";
  const resumeGap = useMemo(() => {
    const watermark = state.resume?.lastEventSeq;
    if (watermark == null) return null;
    let firstAfter: number | null = null;
    for (const turn of traceTurns) {
      for (const item of turn.items) {
        if (item.seq > watermark && (firstAfter == null || item.seq < firstAfter)) {
          firstAfter = item.seq;
        }
      }
    }
    if (firstAfter == null) return null;
    const missing = firstAfter - watermark - 1;
    return missing > 0 ? missing : null;
  }, [traceTurns, state.resume?.lastEventSeq]);

  const startFreshSession = useCallback(() => {
    const sid = lastSessionId;
    const pid = sessionProfile?.id;
    if (!sid || !pid) return;
    setResumeBusy(true);
    sessionRebind(sid, pid, cwd)
      .then((info) => {
        onSession(pid, info.sessionId, null, sid);
        reportResume(sid, { kind: "fresh" }, null);
        patchSession(sid, (s) => ({ ...s, connectError: null }));
        diag(`RESUME new ui=${sid} acp=${info.sessionId}`);
      })
      .catch((e) => {
        const err = asCmdError(e);
        diag(`RESUME new failed ui=${sid} · ${err.code} ${err.msg}`);
        pushSystemNotice(patchSession, sid, t("app.session.newFailed", { code: err.code, msg: localizeText(err.msg, t) }));
      })
      .finally(() => setResumeBusy(false));
  }, [cwd, diag, lastSessionId, onSession, patchSession, reportResume, sessionProfile?.id, t]);

  const activeModeView = modesBySid[lastSessionId] ?? null;
  const activeDefaultModeLabel = sessionProfile?.defaultMode
    ? ((modesByProfile[sessionProfile.id]?.available ?? activeModeView?.available ?? []).find(
        (m) => m.id === sessionProfile.defaultMode,
      )?.name ?? sessionProfile.defaultMode)
    : null;
  const activeAutoApprove: AutoApproveLevel = lastSessionId
    ? (autoApprove[lastSessionId] ?? settings.autoApproveDefault)
    : settings.autoApproveDefault;
  const autoApproveCoveredByAgent = autoApproveCovered(activeModeView?.current ?? null);
  /** 分段控件给的是「选中的档」，不是「切一下」：值没变就不动状态，免得白跑一次渲染 */
  const setAutoApproveLevel = useCallback(
    (level: AutoApproveLevel) => {
      if (!lastSessionId) return;
      setAutoApprove((prev) =>
        prev[lastSessionId] === level ? prev : { ...prev, [lastSessionId]: level },
      );
    },
    [lastSessionId],
  );
  const clearAutoApprove = useCallback((uiSid: string) => {
    setAutoApprove((prev) => {
      if (!(uiSid in prev)) return prev;
      const next = { ...prev };
      delete next[uiSid];
      return next;
    });
  }, []);

  const requestOlder = useCallback(() => {
    if (!hasMore || loadingOlder) return;
    const el = scrollRef.current;
    if (!el) return;
    // 记下当前首条消息在视口里的真实偏移；前插后 hook 用 key 找回它的新索引。
    beginAnchorShift(0);
    scrollAnchorRef.current = {
      sessionId: lastSessionId,
      firstId: state.msgs[0]?.id ?? null,
    };
    void loadOlder();
  }, [beginAnchorShift, hasMore, lastSessionId, loadOlder, loadingOlder, state.msgs]);

  const handleMessageScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = topVisibleRow(virtualRows, el.scrollTop);
    if (top && lastSessionId && !isMessageAdjusting()) {
      const messageId = msgsRef.current[top.index]?.id;
      if (messageId) {
        const anchor = { messageId, offsetTop: top.start - el.scrollTop };
        visibleScrollAnchorRef.current = { uiSid: lastSessionId, anchor };
        const now = Date.now();
        if (now - lastScrollSaveAtRef.current >= 200) {
          saveScroll(lastSessionId, anchor);
          lastScrollSaveAtRef.current = now;
        }
      }
    }
    const range = visibleIndexRange(virtualRows, el);
    if (!range) return;
    if (range.firstVisible <= WINDOW_EDGE && (hasMore || trimmedHead)) requestOlder();
    if (
      range.lastVisible >= state.msgs.length - 1 - WINDOW_EDGE &&
      trimmedTail
    ) {
      void loadNewer();
    }
  }, [
    hasMore,
    isMessageAdjusting,
    lastSessionId,
    loadNewer,
    requestOlder,
    state.msgs.length,
    trimmedHead,
    trimmedTail,
    virtualRows,
  ]);

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    if (anchor.sessionId !== lastSessionId) {
      scrollAnchorRef.current = null;
      return;
    }

    const firstId = state.msgs[0]?.id ?? null;
    if (firstId === anchor.firstId) {
      if (!loadingOlder) {
        scrollAnchorRef.current = null;
        endAnchorShift();
      }
      return;
    }

    // 前插完成：把原锚点行摆回翻页前的视口偏移。
    endAnchorShift();
    scrollAnchorRef.current = null;
  }, [endAnchorShift, lastSessionId, loadingOlder, state.msgs]);

  /**
   * 消息条数与总高由虚拟列表 hook 负责贴底；这里只补列表之外的浮层变化：
   * 权限条、输入框高度和标签切换也会改变底部可用空间。
   */
  // 只用 ref 拿最新的 scrollToEnd：它随条数变化，挂在依赖里会让「加载更早」触发的
  // 一次重渲染也滚到最底部（真机上表现为点一次翻页就被拽走）。
  const scrollToEndRef = useRef(scrollToEnd);
  scrollToEndRef.current = scrollToEnd;

  /**
   * 发送后无条件跳底（docs/desktop-ux.md §27.2）。
   * 滚两次：第二次在下一帧，等虚拟列表把刚追加的那一行量准（行高是估算的）。
   * 用 ref 拿最新实现，identity 稳定，不必挂进 sendInGroup 的依赖。
   */
  const forceScrollToEndRef = useRef(forceScrollToEnd);
  forceScrollToEndRef.current = forceScrollToEnd;
  const jumpToBottomAfterSend = useCallback(() => {
    forceScrollToEndRef.current();
    requestAnimationFrame(() => forceScrollToEndRef.current());
  }, []);
  const scrollEndScopeRef = useRef(`${activeTabId ?? ""}:${lastSessionId}`);
  useEffect(() => {
    const scope = `${activeTabId ?? ""}:${lastSessionId}`;
    if (scrollEndScopeRef.current !== scope) {
      scrollEndScopeRef.current = scope;
      return;
    }
    if (!messageAtBottom) return;
    const raf = requestAnimationFrame(() => scrollToEndRef.current());
    return () => cancelAnimationFrame(raf);
  }, [activeTabId, composerH, lastSessionId, state.pendingPerm]);

  /**
   * 渲染侧对账：界面上到底拿到几条、最后一条是什么。
   * 只记条数与末尾消息的 id/角色/长度，不记正文（日志不该变成对话备份）。
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, [activeTabId, lastSessionId]);

  useEffect(() => {
    const last = state.msgs[state.msgs.length - 1];
    clog(
      "RENDER",
      `ui=${lastSessionId} n=${state.msgs.length} last=${last ? `${last.role}:${last.id.slice(0, 18)}` : "-"} len=${last?.text?.length ?? 0}`,
    );
  }, [state.msgs, lastSessionId]);

  // 队头就是当前要回答的请求：入队后自动弹出；队列清空后自动收起。
  const permHead = permissions.current(lastSessionId);
  const permQueued = permissions.count(lastSessionId);
  useEffect(() => {
    setPermOpen(permHead !== null);
  }, [permHead]);

  // 无感启动：切到某个会话标签（含从侧栏点开）就把它的 agent 拉起来。
  //
  // 尝试记录记的是「会话 + 当时的连接状态」而不是单纯的会话 id：失败之后状态不变，
  // 所以不会每次重渲染都重试（否则错误态会被同一个结果反复刷新）；而断开一次状态就变了，
  // 用户再点回来就能重连 —— 断开是「现在别连」，不是「永久别连」（docs/desktop-ux.md §1.5）。
  /** 无感连接 / 重试在飞：让「打开 → 可用」这一段有完整的过渡，而不是只等历史读回 */
  const [connectPending, setConnectPending] = useState<Record<string, boolean>>({});
  const markConnecting = useCallback((sid: string, pending: boolean) => {
    setConnectPending((prev) => ({ ...prev, [sid]: pending }));
  }, []);

  const handleConnectResult = useCallback(
    (sid: string, result: EnsureResult) => {
      if (result.resume) reportResume(sid, result.resume, result.lastEventSeq);
      const error = result.error;
      if (error) {
        patchSession(sid, (s) => ({
          ...s,
          connectError: {
            code: String(error.code),
            message: error.msg,
            key: error.key,
            params: error.params,
          },
        }));
        return;
      }
      patchSession(sid, (s) => ({ ...s, connectError: null }));
    },
    [patchSession, reportResume],
  );

  /**
   * 会话 MCP 减少后的显式重连：先真的断开 agent，再走同一条 ensureConnected。
   * 不在名单变化时自动做 —— 那会打断正在飞的轮次。
   */
  const reconnectMcp = useCallback(
    async (uiSid: string, profileId: string) => {
      await disconnect(profileId);
      const result = await ensureConnected(profileId, uiSid, { force: true });
      handleConnectResult(uiSid, result);
      if (result.error) throw result.error;
      if (!result.acpSid) {
        throw { code: 50403, msg: t("app.connect.reconnectNoSession") };
      }
    },
    [disconnect, ensureConnected, handleConnectResult, t],
  );

  const autoTried = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (activeTab?.kind !== "session" || !activeTab.sessionId) return;
    const sid = activeTab.sessionId;
    const pid = sessions.find((s) => s.id === sid)?.profileId ?? activeProfile?.id ?? null;
    if (!pid) return;
    const attemptKey = `${pid}:${sessionsByProfile[pid] ?? "-"}`;
    if (autoTried.current.get(sid) === attemptKey) return;
    autoTried.current.set(sid, attemptKey);
    // 带上当前会话：映射要靠它，不能靠「渲染时谁打开着」
    markConnecting(sid, true);
    void ensureConnected(pid, sid)
      .then((r) => handleConnectResult(sid, r))
      .finally(() => markConnecting(sid, false));
  }, [
    activeTab,
    ensureConnected,
    sessions,
    activeProfile,
    sessionsByProfile,
    handleConnectResult,
    markConnecting,
  ]);

  const [retryBusy, setRetryBusy] = useState(false);
  const retryConnection = useCallback(() => {
    const sid = lastSessionId;
    const pid = sessionProfile?.id;
    // 不许静默返回：没有可用的连接配置也是一种结果，要写进错误态（以前这里直接 return，
    // 点了没反应 —— 所有者报的「切换 session 后重试没反应」有一半就死在这条路上）
    if (!sid || !pid) {
      if (sid) {
        patchSession(sid, (s) => ({
          ...s,
          connectError: { code: "50100", message: t("app.connect.noProfile") },
        }));
      }
      return;
    }
    // 绕过自动连接的「一次就够」记录：手动重试必须真的再连一次
    autoTried.current.set(sid, `${pid}:${sessionsByProfile[pid] ?? "-"}`);
    setRetryBusy(true);
    markConnecting(sid, true);
    diag(`RETRY ui=${sid} pid=${pid} force=1`);
    // 复用已有连接时上一次是秒回，界面等于什么都没发生；给一个最短可见时长（250ms），
    // 让「我点了」这件事一定看得见
    const flash = new Promise((resolve) => setTimeout(resolve, 250));
    void Promise.all([ensureConnected(pid, sid, { force: true }), flash])
      .then(([r]) => {
        diag(`RETRY done ui=${sid} error=${r.error ? `${r.error.code} ${r.error.msg}` : "none"}`);
        handleConnectResult(sid, r);
      })
      .finally(() => {
        setRetryBusy(false);
        markConnecting(sid, false);
      });
  }, [
    ensureConnected,
    handleConnectResult,
    lastSessionId,
    sessionProfile?.id,
    sessionsByProfile,
    markConnecting,
    patchSession,
    diag,
    t,
  ]);

  /**
   * 会话打不开时的那块错误态：同一块，两种落点（docs/desktop-ux.md §8）。
   * 没有历史就占满消息区，有历史就接在最后一条消息之后 —— 视觉只有一份，避免两处走样。
   */
  const errorState = connectProblem ? (
    <ConnectErrorState
      code={connectProblem.code}
      message={connectProblem.message}
      errorKey={connectProblem.key}
      errorParams={connectProblem.params}
      resumeUnavailable={state.resume?.kind === "unavailable"}
      newSessionBusy={resumeBusy}
      retrying={retryBusy}
      onRetry={retryConnection}
      onNewSession={startFreshSession}
      onOpenSettings={
        state.connectError ? () => openTab({ kind: "settings", title: t("app.tab.settings") }) : undefined
      }
    />
  ) : null;

  /** 把 PR 作为引用塞进会话：优先复用已打开的会话标签 */
  const quotePr = useCallback(
    (pr: PrDto, repo: GithubRepo, detail?: PrDetailDto) => {
      const existing = tabs.find((t) => t.kind === "session");
      const sid = existing?.sessionId ?? "s-1";
      if (existing) setActiveTabId(existing.id);
      else openTab({ kind: "session", title: sessions.find((s) => s.id === sid)?.title ?? t("app.tab.session"), sessionId: sid });
      setLastSessionId(sid);
      patchSession(sid, (s) => ({
        ...s,
        msgs: [...s.msgs, { id: newId("u"), role: "user", atomKind: "text.user", at: now(), text: t("app.quotePr.message"), quoted: { kind: "pr", label: `#${pr.number} ${pr.title}`, detail: t("app.quotePr.detail", { slug: repo.name, head: pr.head, base: pr.base, state: t(PR_STATE_LABEL[pr.state]), files: detail?.changedFiles ?? 0, additions: detail?.additions ?? 0, deletions: detail?.deletions ?? 0 }) } }],
      }));
    },
    [openTab, patchSession, sessions, setActiveTabId, setLastSessionId, tabs, t],
  );

  // repo 标签与 pr 标签都要解析身份：PR 详情/ diff 需要 `host/owner/name`。
  const ghRepoId = activeTab?.repoId;
  const repoPhase = ghRepoId ? ghPhases[ghRepoId] : undefined;
  const activeRepoIdentity = useMemo<RepoRefDto | undefined>(
    () =>
      activeRepo && !activeRepo.path
        ? { host: activeRepo.host || null, owner: activeRepo.owner, name: activeRepo.name }
        : undefined,
    [activeRepo],
  );
  const { redetect: redetectGhRepo } = useGhRepo({
    repoId: ghRepoId,
    repoPath: activeRepo?.path,
    repoIdentity: activeRepoIdentity,
    enabled: activeTab?.kind === "repo" || activeTab?.kind === "pr",
    phase: repoPhase,
    onPhase: (repoId, phase) => setGhPhases((prev) => ({ ...prev, [repoId]: phase })),
    onPrs: (repoId, prs) => setPrsByRepo((prev) => ({ ...prev, [repoId]: prs })),
  });

  /** 侧栏计数与仓库头用的是同一份 identity：已就绪的 phase 优先，browseOnly 直接用库里的远端身份。 */
  const identityByRepo = useMemo(() => {
    const map: Record<string, RepoRefDto | undefined> = {};
    for (const repo of repoList) {
      const phase = ghPhases[repo.id];
      // browseOnly 没有路径可 resolve，但远端身份已经在库里：PR 由它直接驱动。
      map[repo.id] =
        phase?.kind === "ready"
          ? phase.identity
          : repo.path
            ? undefined
            : { host: repo.host || null, owner: repo.owner, name: repo.name };
    }
    return map;
  }, [ghPhases, repoList]);

  const prKey =
    activeTab?.kind === "pr" && activeTab.repoId && activeTab.prNumber != null
      ? `${activeTab.repoId}:${activeTab.prNumber}`
      : null;
  const prIdentity = activeTab?.repoId ? identityByRepo[activeTab.repoId] : undefined;
  const activePrNumber = activeTab?.kind === "pr" ? activeTab.prNumber : undefined;
  const activePrDetail = prKey ? prDetails[prKey] : undefined;

  /** 已发起过的请求：标签开关不重复拉，但详情本身仍留在内存。 */
  const requestedDetails = useRef<Set<string>>(new Set());
  const requestedDiffs = useRef<Set<string>>(new Set());

  const loadPrDetail = useCallback(
    (identity: RepoRefDto, number: number, key: string) => {
      if (requestedDetails.current.has(key)) return;
      requestedDetails.current.add(key);
      // 先清掉上一次的错误，界面回到骨架而不是一直挂着失败。
      setPrDetails((prev) =>
        prev[key]?.error ? { ...prev, [key]: {} } : prev,
      );
      void ghPrDetail(identity, number)
        .then((detail) => setPrDetails((prev) => ({ ...prev, [key]: { detail } })))
        .catch((e) => setPrDetails((prev) => ({ ...prev, [key]: { error: asCmdError(e) } })));
    },
    [],
  );

  const retryPrDetail = useCallback(
    (identity: RepoRefDto, number: number, key: string) => {
      // 「重试」是一次显式请求：清掉记录，允许重新发起。
      requestedDetails.current.delete(key);
      loadPrDetail(identity, number, key);
    },
    [loadPrDetail],
  );

  useEffect(() => {
    if (!prKey || !prIdentity || activePrNumber == null) return;
    loadPrDetail(prIdentity, activePrNumber, prKey);
  }, [activePrNumber, loadPrDetail, prIdentity, prKey]);

  const activeDiffPage = prKey ? diffPageByPr[prKey] ?? 0 : 0;
  const activeDiffKey = prKey ? `${prKey}:${activeDiffPage}` : null;

  const loadDiffPage = useCallback(
    (identity: RepoRefDto, number: number, page: number, key: string, force: boolean) => {
      if (!force && (requestedDiffs.current.has(key) || diffErrors[key])) return;
      requestedDiffs.current.add(key);
      if (force) {
        setDiffErrors((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      void ghPrDiff(identity, number, page)
        .then((result) => setDiffPages((prev) => ({ ...prev, [key]: result })))
        .catch((e) => setDiffErrors((prev) => ({ ...prev, [key]: asCmdError(e) })));
    },
    [diffErrors],
  );

  useEffect(() => {
    if (!prKey || activeDiffKey == null || !prIdentity || activePrNumber == null) return;
    loadDiffPage(prIdentity, activePrNumber, activeDiffPage, activeDiffKey, false);
  }, [activeDiffKey, activeDiffPage, activePrNumber, loadDiffPage, prIdentity, prKey]);

  const activeDiff: DiffPageDto | undefined = activeDiffKey
    ? diffPages[activeDiffKey]
    : undefined;
  const activeDiffError = activeDiffKey ? diffErrors[activeDiffKey] : undefined;
  const activeDiffPhase: DiffPhase = activeDiffError
    ? "failed"
    : activeDiff
      ? "ready"
      : "loading";

  // 轨迹拉取：只读库，失败留日志（面板空着比整页报错好）。
  // 轮数上限跟服务端一致（服务端会把 limit 夹到 200 轮、事件 limit×200）——只在面板打开时拉。
  useEffect(() => {
    if (!traceOpen) return;
    let alive = true;
    void sessionTrace(lastSessionId, TRACE_TURN_LIMIT)
      .then((rows) => {
        if (alive) setTraceTurns(rows);
      })
      .catch((e) => clog("TRACE-LOAD-ERR", String(e)));
    return () => {
      alive = false;
    };
  }, [traceOpen, lastSessionId, state.busy, state.pendingPerm, traceTick]);

  const traceView = useMemo(() => toTraceView(traceTurns), [traceTurns]);

  const backfillProfileId = activeSession?.profileId ?? sessionProfile?.id ?? null;
  // 连接态不在这里判断：`sessionsByProfile` 的语义是「这条连接当前的会话」，拿它当展示/投递数据源
  // 违反 data-plane.md §2（守卫测试会红）。没连接时命令返回 50300，界面把码翻成人话即可。
  const canRunTraceBackfill =
    !!backfillProfileId && !!activeAcpSid && !!cwd && !state.busy && !traceBackfill.running;

  const runTraceBackfill = useCallback(async () => {
    const targetSessionId = lastSessionId;
    const profileId = activeSession?.profileId ?? sessionProfile?.id;
    if (!profileId || !activeAcpSid || !cwd) return;
    setTraceBackfill({ sessionId: targetSessionId, running: true, result: null, error: null });
    try {
      const result = await sessionTraceBackfill(
        profileId,
        activeAcpSid,
        targetSessionId,
        cwd,
      );
      setTraceBackfill({ sessionId: targetSessionId, running: false, result, error: null });
      setTraceTick((tick) => tick + 1);
    } catch (e) {
      const message = localizeText(String((e as { msg?: string })?.msg ?? e), t);
      setTraceBackfill((current) =>
        current.sessionId === targetSessionId
          ? { ...current, running: false, error: message }
          : current,
      );
      diag(`TRACE-BACKFILL-ERR ui=${targetSessionId} ${message}`);
      clog("TRACE-BACKFILL-ERR", message);
    }
  }, [
    activeAcpSid,
    activeSession?.profileId,
    cwd,
    diag,
    lastSessionId,
    sessionProfile?.id,
    t,
  ]);

  /** 轨迹 → 正文：滚到该轮第一条消息，并短暂用 accent 环标一下。 */
  const locateMessage = useCallback((messageId: string) => {
    const index = msgsRef.current.findIndex((message) => message.id === messageId);
    if (index < 0) {
      clog(
        "WINDOW-SKIP",
        `ui=${lastSessionId ?? "-"} message=${messageId} window=${msgsRef.current.length}`,
      );
      return;
    }
    scrollToMessageIndex(index, "center");
    setHighlightMessageId(messageId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightMessageId((current) => (current === messageId ? null : current));
      highlightTimerRef.current = null;
    }, 1_200);
  }, [lastSessionId, scrollToMessageIndex]);

  /** 正文 → 轨迹：打开面板，并把当前轮作为定位目标。 */
  const locateTraceTurn = useCallback((turnId: string) => {
    const key = normaliseTurnId(turnId);
    if (!key) return;
    setTraceOpen(true);
    setTraceLocate((current) => ({ turnId: key, tick: (current?.tick ?? 0) + 1 }));
  }, []);

  const locateTargetForTurn = useCallback(
    (turnId: string) => locateTargetOf(state.msgs, turnId),
    [state.msgs],
  );

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const decide = useCallback(async (optionId: string | null, note: string | null = null) => {
    const uiSid = lastSessionId;
    try {
      // null 表示用户取消/Esc：由队列按 kind 找拒绝项，不能硬编码 optionId。
      await permissions.decide(uiSid, optionId, note);
      // 成功**不**往消息流里写「权限决定：允许」。
      //
      // 那条通知以前只存在于内存（没有落库），于是同一个气泡有两种位置：
      // 决定当下排在思考行上方（思考行永远渲染在消息之后），重开会话时
      // 合并逻辑把它接到回答末尾（LOAD db=5 live=2）。用户看到的是「气泡乱跑」。
      // 权限请求与决定属于 agent 的操作轨迹（E10 落库后进轨迹面板），不是对话内容。
    } catch (e) {
      const err = asCmdError(e);
      // 应答没写出去时队头仍在，界面继续显示请求；这条是「当前状态坏了」，必须留痕，
      // 而且要走落库版提示，否则重开会话它又会换位置。
      pushSystemNotice(patchSession, uiSid, t("app.permission.decideFailed", { code: err.code, msg: localizeText(err.msg, t) }));
    }
  }, [lastSessionId, patchSession, permissions.decide, t]);

  const closeSessionTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    closeTab(id);
    // 标签关掉后这条会话不会再有界面来回答权限请求，队列一并丢弃。
    if (tab?.kind === "session" && tab.sessionId) {
      permissions.dropSession(tab.sessionId);
      clearAutoApprove(tab.sessionId);
    }
  }, [clearAutoApprove, closeTab, permissions.dropSession, tabs]);

  const removeProfileAndPerms = useCallback((id: string) => {
    removeProfile(id);
    permissions.dropProfile(id);
  }, [permissions.dropProfile, removeProfile]);

  const newSession = useCallback((profileIdChoice?: string, cwdOverride?: string) => {
    const id = `s-${Date.now()}`;
    initSession(id);
    // 必须进列表：只在 tab 里存在的话，关掉标签就再也找不回来了
    // 新会话默认继承「最近用的那个连接」：没有选择步骤，也不会掉到一个空归属上；
    // 用户在侧栏拆分按钮的下拉里指定了连接时，以他选的为准
    const inheritProfile =
      (profileIdChoice ? profiles.find((p) => p.id === profileIdChoice) : undefined) ??
      profiles.find((p) => p.id === activeSession?.profileId) ??
      activeProfile;
    const summary: SessionSummary = { id, title: t("app.session.newTitle"), cwd: cwdOverride ?? inheritProfile?.cwd ?? "", updatedAt: t("app.session.justNow"), updatedAtSec: Math.floor(Date.now() / 1000), group: "今天", playerIds: [], acpSessionId: null, profileId: inheritProfile?.id }; // i18n-ignore
    setSessions((prev) => [summary, ...prev]);
    sessionUpsert({ id, acpSessionId: null, profileId: inheritProfile?.id ?? null, title: summary.title, cwd: summary.cwd, createdAt: summary.updatedAtSec!, updatedAt: summary.updatedAtSec! }).catch((e) => console.warn("[db] upsert session failed", e));
    openTab({ kind: "session", title: t("app.session.newTitle"), sessionId: id });
    setLastSessionId(id);
  }, [activeProfile, activeSession, profiles, initSession, openTab, setSessions, t]);

  const badgeOf = useCallback((t: Tab) => {
    if (t.kind !== "session" || !t.sessionId) return null;
    const st = sessionState[t.sessionId];
    if (!st) return null;
    if (st.pendingPerm) return "var(--warn)";
    if (st.busy) return "var(--ok)";
    return null;
  }, [sessionState]);

  /** 待确认删除的会话（删除不可逆：确认框负责把后果说准） */
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  /** 删除失败时把原因留在确认框里，而不是弹一个系统 alert */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /**
   * 删除会话：**只删本软件里的**（消息、会话行、群成员关系）。
   * agent 侧那个会话原样留着 —— 用户能在别处接着用它，这一点必须在确认框里写明。
   */
  const confirmDeleteSession = async () => {
    const target = pendingDelete;
    if (!target) return;
    setDeleteError(null);
    try {
      await sessionDelete(target.id);
      setSessions((list) => list.filter((x) => x.id !== target.id));
      // 按会话 id 关，不查 tabs 快照：对话框是异步的，快照可能已经不新鲜。
      closeSessionTabs(target.id);
      clearAutoApprove(target.id);
      if (visibleScrollAnchorRef.current?.uiSid === target.id) {
        visibleScrollAnchorRef.current = null;
      }
      forget(target.id);
      setPendingDelete(null);
    } catch (e) {
      const err = asCmdError(e);
      // 失败就留在框里说清楚：没删成，别让用户以为删了
      setDeleteError(`${err.code} ${errorTextOf(err, t)}`);
    }
  };

  /**
   * 群里的发送：`@handle（docs/group-chat.md §3）`。
   *
   * - 没有 @ → 照旧投主 agent；
   * - @ 到本群成员 → 只投给那个成员（它自己的连接、它自己的 ACP 会话）；
   * - @ 了不在群里的人 → **明确失败**，不把这条消息当普通文本投给主 agent，
   *   否则用户以为成员收到了，其实是群主替他答的。
   */
  /** 首条消息落地后后端会把标题改成正文，这里把列表读回来（否则侧栏还是「新会话」） */
  const refreshTitles = useCallback(() => {
    void reloadSessions();
  }, [reloadSessions]);

  const enqueueForSession = useCallback((sid: string, text: string) => {
    const next = enqueuePrompt(queuedBySessionRef.current[sid] ?? [], {
      id: newId("queued"),
      text,
    });
    queuedBySessionRef.current = { ...queuedBySessionRef.current, [sid]: next };
    setQueuedBySession((prev) => ({ ...prev, [sid]: next }));
  }, []);

  const markUndelivered = useCallback(
    (sid: string, text: string) => {
      const message: Extract<Message, { role: "user" }> = {
        id: newId("u"),
        role: "user",
        atomKind: "text.user",
        text,
        at: now(),
        turnId: null,
        undelivered: true,
      };
      patchSession(sid, (s) => ({ ...s, msgs: [...s.msgs, message] }));
    },
    [patchSession],
  );

  const waitForSessionIdle = useCallback((sid: string, timeoutMs: number) => {
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (!sessionStateRef.current[sid]?.busy) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(tick, 50);
      };
      tick();
    });
  }, []);

  const sendSteer = useCallback(
    async (raw: string) => {
      const sid = lastSessionId;
      const acpSid = activeAcpSid;
      const text = raw.trim();
      if (!sid || !acpSid || !text) return;

      const turnId = turnIdForPersist(acp.acpToTurn.current[acpSid]);
      const aside: Message = {
        id: newId("aside"),
        role: "user",
        atomKind: "aside",
        text,
        at: now(),
        kind: "aside",
        turnId,
      };
      // 先上屏：后端回执可能比 IPC 返回值更早到，回执要能找到这一条。
      patchSession(sid, (s) => ({ ...s, msgs: [...s.msgs, aside] }));
      try {
        await sessionSteer(acpSid, sid, text);
      } catch (e) {
        patchSession(sid, (s) => ({ ...s, msgs: s.msgs.filter((m) => m.id !== aside.id) }));
        const err = asCmdError(e);
        clog("ASIDE-ERR", `ui=${sid} acp=${acpSid} ${err.code} ${err.msg}`);
        pushSystemNotice(patchSession, sid, t("app.notice.steerFailed", { msg: localizeText(err.msg, t) }));
        return;
      }

      await messagesAppend(sid, [
        {
          id: aside.id,
          role: "user",
          kind: "aside",
          payload: { ...aside, kind: "aside" },
          // 插话属于它打断的那一轮；拿不到真 id 时显式非轮次，不让后端去猜。
          ...(turnId ? { turnId } : { nonTurn: true }),
        },
      ]).catch((e: unknown) => {
        clog("ASIDE-DB-ERR", `ui=${sid} id=${aside.id} ${String(e)}`);
      });
    },
    [acp, activeAcpSid, lastSessionId, patchSession, t],
  );

  const sendInGroup = useCallback(
    async (raw: string, opts: SendInGroupOptions = {}) => {
      const sid = opts.sid ?? lastSessionId;
      const busyNow = !!sessionStateRef.current[sid]?.busy;
      if (busyNow && !opts.fromQueue) {
        if (settings.busyInputMode === "queue") {
          enqueueForSession(sid, raw);
          return;
        }
        if (settings.busyInputMode === "steer") {
          await sendSteer(raw);
          return;
        }
      }

      let resolved: Awaited<ReturnType<typeof mentionResolve>>;
      try {
        // 谁在群里、他连的哪条连接、cwd 是什么：全部由后端一次判定。
        resolved = await mentionResolve(sid, raw);
      } catch (e) {
        const err = asCmdError(e);
        pushSystemNotice(patchSession, sid, localizeText(err.msg, t));
        return;
      }

      const target =
        resolved.memberId && resolved.profileId && resolved.acpSessionId
          ? {
              profileId: resolved.profileId,
              acpSessionId: resolved.acpSessionId,
              authorId: resolved.memberId,
              cwd: resolved.cwd,
            }
          : undefined;

      if (resolved.memberId && !target) {
        pushSystemNotice(patchSession, sid, t("app.notice.memberIncomplete"));
        return;
      }

      if (resolved.token) {
        pushSystemNotice(
          patchSession,
          sid,
          t("app.notice.memberNotInGroup", { token: resolved.token }),
        );
        return;
      }

      if (busyNow && !opts.fromQueue && settings.busyInputMode === "interrupt") {
        const queuedSession = sessions.find((session) => session.id === sid);
        const profileId =
          target?.profileId ??
          queuedSession?.profileId ??
          (sid === lastSessionId ? sessionProfile?.id : undefined);
        const acpSessionId = target?.acpSessionId ?? acpSessionOf(sid);
        if (!profileId || !acpSessionId) {
          markUndelivered(sid, raw);
          pushUiNotice(sid, {
            severity: "error",
            title: i18nText("notice.interruptFailed.title"),
            description: i18nText("app.notice.stopNoSession"),
          });
          return;
        }

        setInterrupting((prev) => ({ ...prev, [sid]: true }));
        try {
          await sessionCancel(profileId, acpSessionId);
          const idle = await waitForSessionIdle(sid, 5_000);
          if (!idle) {
            markUndelivered(sid, raw);
            pushUiNotice(sid, {
              severity: "error",
              title: i18nText("notice.interruptTimeout.title"),
              description: i18nText("notice.interruptTimeout.description"),
            });
            return;
          }
          // 用户这次发送确实发生在 running 期间；即使刚等到了 cancelled，
          // 仍要保留这个事实，Hermes 在服务端还没真正放开时才能触发兜底判定。
          await send(raw, target, true, sid);
          refreshTitles();
          if (sid === lastSessionId) jumpToBottomAfterSend();
        } catch (e) {
          const err = asCmdError(e);
          markUndelivered(sid, raw);
          pushUiNotice(sid, {
            severity: "error",
            title: i18nText("notice.interruptFailed.title"),
            description: localizeText(err.msg, t),
          });
        } finally {
          setInterrupting((prev) => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
        }
        return;
      }

      await send(raw, target, opts.busyAtSend ?? false, sid);
      refreshTitles();
      if (sid === lastSessionId) jumpToBottomAfterSend();
    },
    [
      acpSessionOf,
      enqueueForSession,
      jumpToBottomAfterSend,
      lastSessionId,
      markUndelivered,
      patchSession,
      pushUiNotice,
      refreshTitles,
      send,
      sendSteer,
      sessions,
      sessionProfile?.id,
      settings.busyInputMode,
      t,
      waitForSessionIdle,
    ],
  );

  const sendInGroupRef = useRef(sendInGroup);
  useEffect(() => {
    sendInGroupRef.current = sendInGroup;
  }, [sendInGroup]);

  /** 轮终态（busy 收起）后按序续发各会话的本地队列。 */
  useEffect(() => {
    for (const [sid, queued] of Object.entries(queuedBySessionRef.current)) {
      if (queued.length === 0) continue;
      if (sessionStateRef.current[sid]?.busy) continue;
      if (interrupting[sid] || flushingQueueRef.current.has(sid)) continue;
      const { next, rest } = dequeuePrompt(queued);
      if (!next) continue;
      queuedBySessionRef.current = { ...queuedBySessionRef.current, [sid]: rest };
      setQueuedBySession((prev) => ({ ...prev, [sid]: rest }));
      flushingQueueRef.current.add(sid);
      void sendInGroupRef
        .current(next.text, { fromQueue: true, busyAtSend: false, sid })
        .finally(() => {
          flushingQueueRef.current.delete(sid);
          setQueueTick((tick) => tick + 1);
        });
    }
  }, [interrupting, queueTick, queuedBySession, sessionState]);

  /**
   * 停止按钮必须把取消送到 agent，而不是只关掉本地的「生成中」。
   * 请求送达后继续保持 busy，等 promptResult / promptFailed 给出真正终态。
   */
  const stopGeneration = useCallback(async () => {
    const sid = lastSessionId;
    if (cancelling[sid]) return;
    // 群里 @ 成员的轮次也走同一个 busy 状态；活动 id 里带着实际 ACP 会话。
    const runningAct = [...state.acts]
      .reverse()
      .find((a) => a.status === "running" && a.id.startsWith("act-stream-"));
    const acpFromAct = runningAct?.id.slice("act-stream-".length);
    const member =
      runningAct && runningAct.playerId !== MAIN_AGENT_ID
        ? members.find((m) => m.id === runningAct.playerId)
        : undefined;
    if (runningAct && runningAct.playerId !== MAIN_AGENT_ID && !member) {
      patchSession(sid, (s) => ({ ...s, busy: false }));
      pushSystemNotice(patchSession, sid, t("app.notice.stopNoMemberConfig"));
      return;
    }
    const profileId = member?.profileId ?? activeSession?.profileId ?? sessionProfile?.id;
    const acpSessionId =
      acpFromAct ??
      member?.acpSessionId ??
      // 绝不退到「连接当前会话」：那可能正是另一条会话的 agent 上下文。
      activeAcpSid;

    if (!profileId || !acpSessionId) {
      patchSession(sid, (s) => ({ ...s, busy: false }));
      pushSystemNotice(patchSession, sid, t("app.notice.stopNoSession"));
      return;
    }

    setCancelling((prev) => ({ ...prev, [sid]: true }));
    try {
      await sessionCancel(profileId, acpSessionId);
      // 成功不改 busy：等 agent 回终态，避免界面先「停了」而 agent 还在写。
    } catch (e) {
      const err = asCmdError(e);
      setCancelling((prev) => ({ ...prev, [sid]: false }));
      patchSession(sid, (s) => ({ ...s, busy: false }));
      pushSystemNotice(patchSession, sid, t("app.notice.stopFailed", { code: err.code, msg: localizeText(err.msg, t) }));
    }
  }, [
    activeAcpSid,
    activeSession?.profileId,
    cancelling,
    lastSessionId,
    members,
    patchSession,
    sessionProfile?.id,
    state.acts,
    t,
  ]);

  /** 停一次派活：先进入「正在停止…」，失败必须删 key，否则会一直卡在停止中。 */
  const cancelDelegate = useCallback(
    async (handleId: string) => {
      if (delegateRunning[handleId] !== "running") return;
      setDelegateRunning((current) => ({ ...current, [handleId]: "cancelling" }));
      try {
        await delegateCancel(handleId);
        // 成功也不删：等 delegateWait 收到子会话终态再退出「正在停止…」。
      } catch (e) {
        const err = asCmdError(e);
        setDelegateRunning((current) => {
          const next = { ...current };
          delete next[handleId];
          return next;
        });
        if (lastSessionId) {
          pushSystemNotice(
            patchSession,
            lastSessionId,
            t("app.notice.stopDelegateFailed", {
              reason: translateKey(t, delegateCancelFailureKey(err.code), { code: err.code }),
            }),
          );
        }
      }
    },
    [delegateRunning, lastSessionId, patchSession, t],
  );

  /**
   * 用发现到的命令直接建连接：program / args / 环境 / 工作目录都已经知道，
   * 让用户再手填一遍是白费功夫（也最容易填错）。这里只组装预填值，
   * 真正的草稿与入库都在设置页完成。
   */
  const useDiscovered = (c: DiscoveryCandidate, hit: DiscoveryHit): Partial<AgentProfile> => {
    const wsl = hit.host.startsWith("wsl:");
    return {
      launch: wsl ? "wsl" : "local",
      distro: wsl ? hit.host.slice("wsl:".length) : undefined,
      shell: wsl ? "zsh" : undefined,
      program: c.acpProgram,
      args: [...c.acpArgs],
      // 远端命令是 cd '<cwd>'，~ 不会被展开，所以用扫出来的绝对家目录
      cwd: hit.home ?? "",
    };
  };

  const memberPanelMember = memberPanel
    ? members.find((m) => m.id === memberPanel.id)
    : undefined;
  const memberPanelProfile = memberPanelMember
    ? profiles.find((p) => p.id === memberPanelMember.profileId)
    : undefined;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-0 text-ink-1">
      <TitleBar profile={sessionProfile} cwd={cwd} />

      {settingsError && (
        <div
          role="alert"
          className="sc-glass mx-1 mb-1 flex items-center gap-2 rounded-card px-3 py-1.5 text-caption text-danger-1"
        >
          <span className="min-w-0 flex-1 break-words">{settingsError}</span>
          <Tooltip label={t("app.settingsError.dismiss")}>
            <button
              type="button"
              aria-label={t("app.settingsError.dismiss")}
              onClick={() => setSettingsError(null)}
              className="shrink-0 rounded-mark p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              <X className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      )}

      <div ref={layoutRef} className="flex min-h-0 flex-1 px-1 pb-1">
        <Sidebar
          width={sidebarW}
          mode={mode}
          onModeChange={setMode}
          sessions={sessions}
          activeId={lastSessionId}
          profiles={profiles}
          players={players}
          repos={repoList}
          prsByRepo={prsByRepo}
          identityByRepo={identityByRepo}
          focusAddSignal={addRepoSignal}
          onSelect={(id) =>
            openTab({
              kind: "session",
              title: sessions.find((s) => s.id === id)?.title ?? t("app.tab.session"),
              sessionId: id,
            })
          }
          onNew={() => newSession()}
          onNewWithProfile={(pid) => newSession(pid)}
          onOpenSettings={() => openTab({ kind: "settings", title: t("app.tab.settings") })}
          onDeleteSession={(x) => {
            setDeleteError(null);
            setPendingDelete(x);
          }}
          isSessionBusy={(id) => !!sessionState[id]?.busy}
          onOpenRepo={(repoId) => {
            const repo = repoList.find((r) => r.id === repoId);
            openTab({ kind: "repo", title: repo?.name ?? t("app.tab.repo"), repoId });
          }}
          onAddRepo={addRepo}
          onAddFromGh={addFromGh}
          onPin={pin}
          onNewSessionForRepo={(repo) => newSession(undefined, repo.path)}
        />

        <Splitter
          value={sidebarW}
          onChange={setSidebarW}
          onDragChange={setDragging}
          min={200}
          max={sidebarMax}
        />

        <TracePanel
          open={traceOpen}
          width={traceW}
          animate={!dragging}
          focusId={focus?.id ?? null}
          focusTick={focus?.tick ?? 0}
          locateTurnId={traceLocate?.turnId ?? null}
          locateTick={traceLocate?.tick ?? 0}
          locateTargetOf={locateTargetForTurn}
          onLocateMessage={locateMessage}
          turns={traceView.turns}
          activities={traceView.activities}
          players={players}
          resumeGap={resumeGap}
          backfill={{
            canRun: canRunTraceBackfill,
            running: traceBackfill.running,
            result:
              traceBackfill.sessionId === lastSessionId ? traceBackfill.result : null,
            error: traceBackfill.sessionId === lastSessionId ? traceBackfill.error : null,
            onRun: () => {
              void runTraceBackfill();
            },
          }}
          onClose={() => {
            setTraceOpen(false);
            setFocus(null);
            setTraceLocate(null);
          }}
        />
        {traceOpen && (
          <Splitter
            value={traceW}
            onChange={setTraceW}
            onDragChange={setDragging}
            min={250}
            max={traceMax}
          />
        )}
        <main className="sc-pane flex min-h-0 flex-1 flex-col overflow-hidden" style={{ minWidth: mainMin }}>
          <TabStrip
            tabs={tabs}
            activeId={activeTabId}
            pinned={pinned}
            badgeOf={badgeOf}
            onSelect={selectTab}
            onClose={closeSessionTab}
            onPin={onPin}
            onUnpin={onUnpin}
          />
          {!activeTab && <WorkspaceEmpty onNewSession={newSession} />}
          {activeTab?.kind === "session" && (
            <>
              <StatusBar
                cwd={cwd}
                profile={sessionProfile}
                sessionId={activeAcpSid ?? undefined}
                eventCount={eventCount}
                lastEvent={lastEvent}
                eventLog={eventLog}
                running={runningItems}
                onOpenTrace={() => {
                  setTraceOpen(true);
                  setFocus(null);
                }}
                modes={activeModeView}
                fallbackLabel={activeDefaultModeLabel}
                resume={state.resume}
                connectError={state.connectError}
                connecting={!!connectPending[lastSessionId]}
                onChooseMode={(modeId) => {
                  const acpSid = activeAcpSid;
                  if (sessionProfile && acpSid) {
                    void choose({
                      profileId: sessionProfile.id,
                      acpSessionId: acpSid,
                      uiSessionId: lastSessionId,
                      modeId,
                    });
                  }
                }}
                traceOpen={traceOpen}
                onToggleTrace={() =>
                  setTraceOpen((v) => {
                    if (v) {
                      setFocus(null);
                      setTraceLocate(null);
                    }
                    return !v;
                  })
                }
                right={
                  <AgentCapabilities
                    profile={sessionProfile}
                    acpCommands={acpCommands}
                  />
                }
              />
              <div className="flex min-h-0 flex-1">
                {/* 竖栏是「谁在这个群里」：历史作者（已移出）不出现在这里，
                    他们的消息与轨迹支线仍然保留身份。 */}
                <ActivityRail
                  players={players.filter((player) => !player.removed)}
                  activities={state.acts}
                  filter={playerFilter}
                  onOpenMember={(member, anchor) => setMemberPanel({ id: member.id, anchor })}
                  group={
                    lastSessionId
                      ? {
                          sessionId: lastSessionId,
                          members,
                          profiles,
                          onChanged: reloadMembers,
                        }
                      : undefined
                  }
                />
                <div key={lastSessionId} className="relative min-h-0 flex-1">
                  <div
                    ref={scrollRef}
                    onScroll={handleMessageScroll}
                    className="h-full overflow-y-auto"
                  >
                    <div
                      className="sc-selectable mx-auto min-h-full w-full max-w-3xl px-4 pt-4"
                      style={{ paddingBottom: composerH + 16 }}
                    >
                      {hasMore && (
                        <button
                          type="button"
                          onClick={requestOlder}
                          className="mx-auto mb-3.5 rounded-md px-2 py-1 text-caption text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-2"
                        >
                          {loadingOlder ? t("app.messages.loadingOlder") : t("app.messages.loadEarlier")}
                        </button>
                      )}
                      {state.msgs.length === 0 ? (
                        connectProblem ? (
                          errorState
                        ) : opening || connectPending[lastSessionId] ? (
                          /* 打开 → 可用这一段：骨架屏（原语自带 300ms 延迟，快的时候看不到）
                             + 一行阶段说明 —— 冷启动时连接可能要几秒，光有条在跳说不出在等什么 */
                          <div className="flex min-h-full flex-col items-center justify-center gap-2">
                            <LoadingState kind="loading" heading={t("app.session.opening")} />
                            <p className="text-caption text-ink-3">
                              {opening ? t("app.session.readingHistory") : t("app.session.connecting")}
                            </p>
                          </div>
                        ) : (
                          <div className="py-12">
                            <EmptyState
                              cwd={cwd}
                              onPick={(t) => {
                                void send(t).then(refreshTitles);
                              }}
                            />
                          </div>
                        )
                      ) : (
                        <>
                          <div className="relative" style={{ height: virtualTotalSize }}>
                            {virtualRows.map((row) => {
                              const m = state.msgs[row.index];
                              if (!m) return null;
                              return (
                                <div
                                  key={row.key}
                                  ref={measureRow}
                                  data-index={row.index}
                                  data-message-id={m.id}
                                  data-turn-id={m.turnId ?? ""}
                                  className="absolute inset-x-0 top-0"
                                  style={{
                                    transform: `translateY(${row.start}px)`,
                                    minHeight: estimateMessage(row.index),
                                  }}
                                  onClickCapture={(event) => {
                                    const target = event.target;
                                    if (
                                      !(target instanceof Element) ||
                                      !target.closest("[aria-expanded]")
                                    ) {
                                      return;
                                    }
                                    // 行内卡片展开前先记锚点，React 更新后下一帧摆回原位。
                                    beginAnchorShift(row.index);
                                    requestAnimationFrame(endAnchorShift);
                                  }}
                                >
                                  <div className="pb-3.5">
                                    <div
                                      className={
                                        "group relative rounded-card transition-shadow" +
                                        (highlightMessageId === m.id
                                          ? " ring-2 ring-accent-1/70"
                                          : "")
                                      }
                                    >
                                      <MessageItem
                                        message={m}
                                        players={renderPlayers}
                                        tweenEnabled={settings.tweenEnabled}
                                        delegatePhase={
                                          m.role === "user" && m.delegate
                                            ? delegateRunning[m.delegate.handleId]
                                            : undefined
                                        }
                                        quoteTargetMissing={
                                          m.role === "user" &&
                                          !!m.quoted?.messageId &&
                                          !visibleMessageIds.has(m.quoted?.messageId ?? "")
                                        }
                                        onCancelDelegate={cancelDelegate}
                                        onLocateTrace={locateTraceTurn}
                                      />
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {state.acts
                            .filter((a) => a.status === "running")
                            .map((a) => {
                              const p = renderPlayers.find((x) => x.id === a.playerId);
                              if (!p) return null;
                              const rowAcpSid = acpSessionIdOfActivity(a.id);
                              const lock = rowAcpSid ? state.locks?.[rowAcpSid] : undefined;
                              return (
                                <div key={a.id} className="pt-3.5">
                                  <ThinkingRow
                                    player={p}
                                    activity={a}
                                    lock={lock ? { title: lock.title, count: lock.count } : undefined}
                                    onOpenTrace={() => {
                                      setTraceOpen(true);
                                      setFocus((f) => ({ id: a.id, tick: (f?.tick ?? 0) + 1 }));
                                    }}
                                  />
                                </div>
                              );
                            })}
                          <div className="pt-3.5 empty:hidden">{errorState}</div>
                        </>
                      )}
                      <div className="pt-3.5 empty:hidden">
                        <StorageNotice key={lastSessionId} stats={storageStats} />
                      </div>
                    </div>
                  </div>
                  <div
                    ref={composerRef}
                    className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3"
                  >
                    <div className="mx-auto max-w-3xl">
                      {state.pendingPerm && (
                        <button
                          onClick={() => setPermOpen(true)}
                          className="sc-glass pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-card px-3 py-1.5 text-left text-caption text-warn-1 transition-colors hover:brightness-110"
                        >
                          <span className="shrink-0 font-medium">
                            {players.find((x) => x.id === state.pendingPerm?.playerId)?.name ??
                              "agent"}
                          </span>
                          <span className="truncate text-ink-2">
                            {t("app.permission.request", {
                              // 剥掉标题末尾的问号（中文全角 / 英文半角都算）；这是判据不是文案
                              title: state.pendingPerm.title.replace(/？\?\s*$/, ""), // i18n-ignore
                            })}
                          </span>
                          <span className="ml-auto shrink-0 text-ink-3">{t("app.permission.view")}</span>
                        </button>
                      )}
                      <div className="pointer-events-auto">
                        <NoticeStack
                          notices={noticesBySession[lastSessionId] ?? []}
                          onDismiss={(id) => dismissUiNotice(lastSessionId, id)}
                        />
                        {isInterrupting && (
                          <div className="sc-glass mb-2 flex items-center gap-2 rounded-card px-3 py-1.5 text-caption text-ink-2">
                            <span className="size-1.5 animate-pulse rounded-full bg-warn-1" />
                            {t("composer.busy.interrupting")}
                          </div>
                        )}
                        {isStopping && (
                          <div className="sc-glass mb-2 flex items-center gap-2 rounded-card px-3 py-1.5 text-caption text-ink-2">
                            <span className="size-1.5 animate-pulse rounded-full bg-warn-1" />
                            {t("app.composer.stoppingNotice")}
                          </div>
                        )}
                        <Composer
                          busy={state.busy}
                          usage={usageLine}
                          onSend={sendInGroup}
                          onSteer={sendSteer}
                          steerGate={steerMode}
                          commands={acpCommands}
                          onStop={stopGeneration}
                          placeholder={
                            isInterrupting
                              ? t("composer.busy.interrupting")
                              : isStopping
                              ? t("app.composer.stopping")
                              : t("app.composer.placeholder")
                          }
                          busyInputMode={settings.busyInputMode}
                          interrupting={isInterrupting}
                          queuedCount={queueCount(queuedBySession[lastSessionId] ?? [])}
                          players={players.filter((player) => !player.removed)}
                          autoApprove={activeAutoApprove}
                          autoApproveCovered={autoApproveCoveredByAgent}
                          onAutoApproveChange={setAutoApproveLevel}
                          turnPolicyKinds={activeTurnPolicy?.kinds ?? []}
                          onRevokeTurnPolicy={() => void revokeTurnPolicy()}
                          sessionId={lastSessionId}
                          uiSid={lastSessionId}
                          sessionProfile={sessionProfile}
                          onReconnectMcp={() =>
                            lastSessionId && sessionProfile
                              ? reconnectMcp(lastSessionId, sessionProfile.id)
                              : Promise.reject({ code: 50300, msg: t("app.composer.noSession") })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
          {activeTab?.kind === "repo" && activeRepo && (
            <RepoBrowser
              repo={activeRepo}
              phase={ghPhases[activeRepo.id] ?? { kind: "checking" }}
              onRedetect={redetectGhRepo}
              onCopy={(text) => void copyText(text)}
              onChooseRepo={() => {
                setMode("code");
                setAddRepoSignal((signal) => signal + 1);
              }}
              onOpenPr={(pr) =>
                openTab({
                  kind: "pr",
                  title: `#${pr.number} ${pr.title}`,
                  subtitle: `${identityByRepo[activeRepo.id]?.owner ?? activeRepo.name}/${identityByRepo[activeRepo.id]?.name ?? ""} · ${pr.head} → ${pr.base}`,
                  repoId: activeRepo.id,
                  prNumber: pr.number,
                })
              }
            />
          )}
          {activeTab?.kind === "settings" && (
            <SettingsView
              settings={settings}
              profiles={profiles}
              theme={settings.theme}
              onUpdateProfile={updateProfile}
              onAddProfile={(draft) => addProfile(draft)}
              discovery={discovery.outcome}
              discoveryScanning={discovery.scanning}
              discoveryError={discovery.error}
              onScanDiscovery={discovery.scan}
              onUseDiscovered={useDiscovered}
              onRemoveProfile={removeProfileAndPerms}
              onConnect={connect}
              onDisconnect={disconnect}
              onDisconnected={permissions.dropProfile}
              modesFor={(pid) => modesByProfile[pid] ?? null}
              onChangeContext={(n) => setSettings((s) => ({ ...s, contextMessages: n }))}
              onCycleTheme={(theme) => setSettings((s) => ({ ...s, theme }))}
              onChangeAutoApproveDefault={(autoApproveDefault) =>
                setSettings((s) => ({ ...s, autoApproveDefault }))
              }
              onChangeBusyInputMode={(busyInputMode) =>
                setSettings((s) => ({ ...s, busyInputMode }))
              }
              onChangeMcpInheritDefault={(mcpInheritDefault) =>
                setSettings((s) => ({ ...s, mcpInheritDefault }))
              }
              onChangeTweenEnabled={(tweenEnabled) =>
                setSettings((s) => ({ ...s, tweenEnabled }))
              }
              onChangeReplySound={(replySound) =>
                setSettings((s) => ({ ...s, replySound }))
              }
              onChangeReplyToast={(replyToast) =>
                setSettings((s) => ({ ...s, replyToast }))
              }
              onChangeCodeTheme={(codeTheme) =>
                setSettings((s) => ({ ...s, codeTheme }))
              }
              onChangeLanguage={(language) => setSettings((s) => ({ ...s, language }))}
            />
          )}
          {activeTab?.kind === "pr" && activeRepo && activePrNumber != null && prIdentity && (
            <PrView
              repo={activeRepo}
              identity={prIdentity}
              prNumber={activePrNumber}
              detail={activePrDetail?.detail}
              detailError={activePrDetail?.error}
              diff={activeDiff}
              diffPhase={activeDiffPhase}
              diffError={activeDiffError}
              onDiffPage={(page) =>
                setDiffPageByPr((prev) => ({ ...prev, [prKey ?? ""]: page }))
              }
              onRetryDiff={() => {
                if (prIdentity && activePrNumber != null && activeDiffKey) {
                  loadDiffPage(prIdentity, activePrNumber, activeDiffPage, activeDiffKey, true);
                }
              }}
              onRetryDetail={() => {
                if (prIdentity && activePrNumber != null && prKey) {
                  retryPrDetail(prIdentity, activePrNumber, prKey);
                }
              }}
              onQuote={() => {
                const sourcePr =
                  activePrDetail?.detail?.pr ??
                  prsByRepo[activeRepo.id]?.find((item) => item.number === activePrNumber);
                if (sourcePr) quotePr(sourcePr, activeRepo, activePrDetail?.detail);
              }}
              onOpenExternal={(url) => {
                if (url) void openExternal(url);
              }}
            />
          )}
          {/* PR 标签先于仓库身份就绪（直接打开历史标签）：显示骨架，等三步回来再渲染。 */}
          {activeTab?.kind === "pr" && activeRepo && activePrNumber != null && !prIdentity && (
            <div className="flex h-full flex-col">
              <header className="shrink-0 border-b border-line-1/60 px-4 py-3">
                <div className="mx-auto max-w-3xl font-mono text-body text-ink-3">#{activePrNumber}</div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3.5">
                  <span className="h-3 w-2/3 animate-pulse rounded-control bg-surface-2" />
                  <span className="h-3 w-full animate-pulse rounded-control bg-surface-2" />
                  <span className="h-20 w-full animate-pulse rounded-control bg-surface-2" />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      <ResizeHandles />
      {memberPanel && memberPanelMember && (
        <MemberDetailPanel
          member={memberPanelMember}
          profile={memberPanelProfile}
          anchor={memberPanel.anchor}
          onClose={() => setMemberPanel(null)}
          onDelegate={() => {
            setDelegateTarget(memberPanelMember);
            setMemberPanel(null);
          }}
          onFilter={() =>
            setPlayerFilter((current) =>
              current === memberPanelMember.id ? null : memberPanelMember.id,
            )
          }
          filtered={playerFilter === memberPanelMember.id}
          onRemove={() => removeGroupMember(memberPanelMember)}
        />
      )}
      {delegateTarget && lastSessionId && (
        <DelegateDialog
          open
          targetName={delegateTarget.name}
          profile={profiles.find((p) => p.id === delegateTarget.profileId)}
          onClose={() => setDelegateTarget(null)}
          onDelegated={() => setDelegateTarget(null)}
          onSubmit={async (task) => {
            const sid = lastSessionId;
            const handle = await delegateTask(sid, delegateTarget.id, task);
            setDelegateRunning((current) => ({ ...current, [handle.handleId]: "running" }));
            void messagesLoad(sid)
              .then((page) => {
                const fromDb = page.messages.map((row) => messageFromRow(row));
                const seqs: Record<string, number> = {};
                for (const row of page.messages) seqs[row.id] = row.seq;
                patchSession(sid, (s) => ({
                  ...s,
                  msgs: mergeMessages(s.msgs, fromDb, seqs),
                }));
              })
              .catch((e) => console.warn("[delegate] messages refresh failed", e));
            // 终态到了才收绳：cancelled 要留在引用条上（答「停没停」），
            // timed_out 说明还在跑（wait 只是不等了），这两种都不能把「停止」摘掉。
            let keepPhase = false;
            void delegateWait(handle.handleId, 120_000)
              .then((outcome) => {
                if (outcome.status === "failed") {
                  pushSystemNotice(
                    patchSession,
                    sid,
                    t("app.delegate.failed", {
                      reason: outcome.stopReason ?? t("app.unknownReason"),
                    }),
                  );
                }
                if (outcome.status === "cancelled") {
                  keepPhase = true;
                  setDelegateRunning((current) => ({
                    ...current,
                    [handle.handleId]: "cancelled",
                  }));
                }
                if (outcome.status === "timed_out") keepPhase = true;
              })
              .catch(() => {
                // 异常不写消息，轨迹那一步已经写着进行中
              })
              .finally(() => {
                if (keepPhase) return;
                setDelegateRunning((current) => {
                  const next = { ...current };
                  delete next[handle.handleId];
                  return next;
                });
              });
          }}
        />
      )}
      {state.pendingPerm && (
        <PermissionDialog
          request={state.pendingPerm}
          player={players.find((x) => x.id === state.pendingPerm?.playerId)}
          open={permOpen}
          onDecide={(optionId, note) => void decide(optionId, note)}
          onAllowTurn={allowTurnPolicy}
          turnPolicyKind={pendingTurnPolicyKind}
          onCancel={(note) => void decide(null, note)}
          queued={permQueued}
        />
      )}

        <ConfirmDialog
          open={!!pendingDelete}
          title={t("app.delete.title", { title: pendingDelete?.title ?? "" })}
          body={
            <ul className="list-disc space-y-0.5 pl-4">
              <li>{t("app.delete.body1")}</li>
              <li>{t("app.delete.body2")}</li>
              <li>
                <Trans
                  i18nKey="app.delete.body3"
                  components={{ span: <span className="text-ink-1" /> }}
                />
              </li>
              {deleteError && (
                <li className="list-none break-all font-mono text-caption text-danger-1">
                  {t("app.delete.failed", { msg: deleteError })}
                </li>
              )}
            </ul>
          }
          confirmLabel={t("app.delete.confirm")}
          onConfirm={confirmDeleteSession}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
        />

    </div>
  );
}

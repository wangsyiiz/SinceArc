import {
  createContext,
  useContext,
  type Dispatch,
  type JSX,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import type { DelegatePhase } from "@/lib/delegate-status";
import type { QueuedPrompt } from "@/lib/busy-input";
import type { CommandDto } from "@/lib/ipc/types.gen/CommandDto";
import type { AgentUser, StorageStatsDto } from "@/lib/ipc";
import type { UiNotice } from "@/lib/notice-inbox";
import type { SteerGate } from "@/lib/steer-availability";
import type { VirtualRow } from "@/lib/virtual/useVirtualList";
import type { ModeView } from "@/hooks/useSessionModes";
import type {
  AgentProfile,
  AutoApproveLevel,
  Player,
  SessionState,
  ThreadSettings,
} from "@/types";

export interface Focus {
  id: string;
  tick: number;
}

export interface TraceLocate {
  turnId: string;
  tick: number;
}

export interface MemberPanel {
  id: string;
  anchor: HTMLElement;
}

export interface UnreadJump {
  sessionId: string;
  messageId: string | null;
  count: number;
}

export interface TurnPolicy {
  profileId: string;
  acpSessionId: string;
  turnId: string;
  kinds: string[];
}

export interface ConnectProblem {
  code?: string;
  message: string;
  key?: string;
  params?: Record<string, string>;
}

export interface RunningItem {
  name: string;
  title: string;
  startedAt: number;
}

export interface EventLogItem {
  at: number;
  text: string;
}

export interface UsageLine {
  text: string;
  warn: boolean;
  percent: number;
}

export interface SendInGroupOptions {
  /** 指定界面会话（后台队列续发）；不传就是当前打开的会话 */
  sid?: string;
  /** 用户发起时本轮已在跑：用于 400ms 兜底判定 */
  busyAtSend?: boolean;
  /** 从本地队列续发：不再进入忙碌分流 */
  fromQueue?: boolean;
}

export interface Workspace {
  state: SessionState;
  hasMore: boolean;
  loadingOlder: boolean;
  opening: boolean;
  players: Player[];
  renderPlayers: Player[];
  virtualRows: VirtualRow[];
  virtualTotalSize: number;
  measureRow: (node: Element | null) => void;
  beginAnchorShift: (index: number) => void;
  endAnchorShift: () => void;
  visibleMessageIds: Set<string>;
  settings: ThreadSettings;
  t: TFunction;
  cwd: string;
  sessionProfile: AgentProfile | undefined;
  activeAcpSid: string | null;
  eventCount: number;
  lastEvent: string;
  eventLog: EventLogItem[];
  runningItems: RunningItem[];
  activeModeView: ModeView | null;
  activeDefaultModeLabel: string | null;
  connectPending: Record<string, boolean>;
  choose: (args: {
    profileId: string;
    acpSessionId: string;
    uiSessionId: string;
    modeId: string | null;
  }) => Promise<void>;
  traceOpen: boolean;
  setTraceOpen: Dispatch<SetStateAction<boolean>>;
  setFocus: Dispatch<SetStateAction<Focus | null>>;
  setTraceLocate: Dispatch<SetStateAction<TraceLocate | null>>;
  acpCommands: CommandDto[] | undefined;
  playerFilter: string | null;
  setMemberPanel: Dispatch<SetStateAction<MemberPanel | null>>;
  members: AgentUser[];
  profiles: AgentProfile[];
  reloadMembers: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  handleMessageScroll: () => void;
  composerH: number;
  requestOlder: () => void;
  connectProblem: ConnectProblem | null;
  errorState: ReactNode;
  send: (text: string) => Promise<void>;
  refreshTitles: () => void;
  estimateMessage: (index: number) => number;
  highlightMessageId: string | null;
  delegateRunning: Record<string, DelegatePhase>;
  cancelDelegate: (handleId: string) => void | Promise<void>;
  locateTraceTurn: (turnId: string) => void;
  storageStats: StorageStatsDto | null;
  composerRef: RefObject<HTMLDivElement | null>;
  unreadJump: UnreadJump | null;
  jumpToFirstUnread: () => Promise<void>;
  setPermOpen: Dispatch<SetStateAction<boolean>>;
  noticesBySession: Record<string, UiNotice[]>;
  dismissUiNotice: (sid: string, id: string) => void;
  isInterrupting: boolean;
  isStopping: boolean;
  usageLine: UsageLine | null;
  sendInGroup: (text: string, opts?: SendInGroupOptions) => Promise<void>;
  sendSteer: (text: string) => Promise<void>;
  steerMode: SteerGate;
  stopGeneration: () => Promise<void>;
  queuedBySession: Record<string, QueuedPrompt[]>;
  activeAutoApprove: AutoApproveLevel;
  autoApproveCoveredByAgent: boolean;
  setAutoApproveLevel: (level: AutoApproveLevel) => void;
  activeTurnPolicy: TurnPolicy | undefined;
  revokeTurnPolicy: () => Promise<void>;
  reconnectMcp: (uiSid: string, profileId: string) => Promise<void>;
  lastSessionId: string;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: Workspace;
  children: ReactNode;
}): JSX.Element {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (value === null) {
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  }
  return value;
}

import type { AgentCaps } from "@/lib/ipc/types.gen/AgentCaps";

export type ThemeMode = "dark" | "light" | "system";

/** 本机直连 / 经 wsl.exe / 经 ssh（本地与远程同一条路径，只差 host） */
export type LaunchKind = "local" | "wsl" | "ssh";

export type SshAuth = "key" | "password";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** auth = "key" 时的私钥路径（Windows 侧绝对路径） */
  keyPath?: string;
  /** auth = "password" 时的口令；只在内存里过一手，不落盘 */
  password?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  launch: LaunchKind;
  detail: string;
  connected: boolean;
  agentName?: string | null;
  protocolVersion?: number | null;
  /** 仅 launch = "ssh" 时有值 */
  ssh?: SshConfig;
  /** 远端命令的工作目录（ssh 时是远端路径） */
  cwd?: string;
  /** 连接的默认编辑审批模式；null/undefined = 不推，跟随 agent 默认 */
  defaultMode?: string | null;
  /** 启动命令（如 hermes acp / npx -y @agentclientprotocol/codex-acp） */
  program?: string;
  args?: string[];
  /**
   * 上次握手报上来的协议能力。
   * `null` = 还没连过；它是「这个 agent 支持什么」的唯一可信来源。
   */
  caps: AgentCaps | null;
  /** 上次握手能力落库的时间（秒）；从未握手为 null。 */
  capsAt: number | null;
  /** WSL 场景 */
  distro?: string;
  shell?: string;
}

/** ACP 之外的能力（agent 自己的 CLI），不属于协议本体 */
export interface AgentCommand {
  /**
   * 跑这条子命令用的**二进制**（如 hermes / codex）。
   * 注意它不一定等于 profile.program：codex 的 ACP 是通过 `npx …codex-acp` 起的，
   * 但它的 CLI 叫 `codex`。预览必须按这个字段拼，否则会拼出一条跑不通的命令。
   */
  binary: string;
  id: string;
  label: string;
  argv: string[];
  note?: string;
}

/** 群聊里的「玩家」= 一个 agent profile + 一个独立 session */
export interface Player {
  id: string;
  name: string;
  handle: string;
  color: string;
  profileId: string;
  busy: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  /** 后端给的简短显示时间：今天 `HH:mm`，更早 `MM-DD` */
  updatedAt: string;
  /** 库里的时间戳（秒）；排序/去重仍用它，不再用它算分组 */
  updatedAtSec?: number;
  /** 由后端按机器本地时区判定，前端只映射成中文 */
  group: "今天" | "昨天" | "更早";
  /** 这个会话里有哪些玩家 */
  playerIds: string[];
  /** 绑定的 ACP 会话 id：事件按它归属，重连时优先复用 */
  acpSessionId?: string | null;
  /** 哪个连接配置下的会话 */
  profileId?: string;
}

/* ---------- 过程（不再进聊天流） ---------- */
export type ActivityKind =
  | "thinking"
  | "read"
  | "edit"
  | "execute"
  | "search"
  | "plan"
  | "permission"
  | "delegate";

/** cancelled = 用户中途停止；它既不是成功也不是错误，界面上不能用红色 */
export type ActivityStatus = "running" | "ok" | "error" | "cancelled";

export interface Activity {
  id: string;
  playerId: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  /** 卡片里的全文；思考保留换行，工具/权限是逐行落点或选项。 */
  body?: string;
  /** 后端是否截断过这条 payload（思考的 8KB 上限）。 */
  truncated?: boolean;
  /** permission_decision 的结论；普通权限请求没有 */
  decision?: "allow" | "reject";
  meta?: string;
  status: ActivityStatus;
  at: string;
}

/** 一轮里的一条支线 = 某个玩家被 @ 之后的动作串 + 它的回复 */
export interface TraceBranch {
  playerId: string;
  activityIds: string[];
  reply?: string;
  status: "done" | "running";
}

/** 一轮：用户发话 → 并行的 N 条支线（每条属于一个玩家） */
export type TraceTurnStatus =
  | "running"
  | "waiting_approval"
  | "finished"
  | "cancelled"
  | "failed"
  | "unknown";

export interface TraceTurn {
  id: string;
  at: string;
  userText: string;
  branches: TraceBranch[];
  /** 这一轮的终态；cancelled 时界面上要写「已停止」，不能当成正常结束 */
  status?: TraceTurnStatus;
  /** agent 原始的 stopReason：finished 且不是 end_turn 时界面要把它写出来 */
  stopReason?: string;
}

/* ---------- 聊天流：只留「人对人的话」 ---------- */
export type Message =
  | { id: string; role: "user"; text: string; at: string; quoted?: QuotedRef }
  | { id: string; role: "player"; playerId: string; text: string; at: string; streaming?: boolean; /** 用户中途点了停止：已生成的部分保留，但要标出来 */ stopped?: boolean }
  | { id: string; role: "system"; text: string; at: string };

/** 「加入对话」带进来的引用（PR / issue / 文件） */
export interface QuotedRef {
  kind: "pr" | "issue" | "file";
  label: string;
  detail?: string;
}

/* ---------- Git / 权限 ---------- */
/** GitHub 项目：独立于聊天窗口，按路径绑定 gh 的工作目录 */
export interface GithubRepo {
  id: string;
  name: string;
  slug: string;
  path: string;
  branch: string;
  connected: boolean;
}

export interface GithubPR {
  number: number;
  title: string;
  author: string;
  head: string;
  base: string;
  state: "open" | "draft" | "merged" | "closed";
  comments: number;
  additions: number;
  deletions: number;
  files: number;
  checks: "pending" | "passing" | "failing";
  updatedAt: string;
  body: string;
}

export interface PermissionOption {
  id: string;
  label: string;
  tone: "allow" | "always" | "reject";
}

export interface PermissionRequest {
  id: string;
  playerId: string;
  /** ACP 原始 toolCall.kind；保留原值，未知/缺失为 null */
  kind: string | null;
  title: string;
  detail: string;
  meta?: string;
  options: PermissionOption[];
  /**
   * 请求已失效的原因。存在即表示 expired（没有单独的时间戳字段）：
   * 轮次终态或连接断开后，选项不能再作答。
   */
  expiredReason?: string;
  /** 开了自动同意但这条请求不满足条件时，弹窗里要说明为什么没自动答。 */
  autoSkippedReason?: string;
}

/* ---------- 右侧工作区标签 ---------- */
export type TabKind = "session" | "repo" | "pr" | "settings";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  subtitle?: string;
  sessionId?: string;
  repoId?: string;
  prNumber?: number;
}

/** 每个会话一份独立状态：切走标签不销毁 session，也不丢消息 */
export interface SessionResumeState {
  kind: "resumed" | "unavailable";
  acpSessionId: string;
  /** Resumed: agent 名变化等提示（可能为空） */
  note?: string;
  /** Unavailable: 为什么续不上 */
  reason?: string;
  /** 恢复前本地事件水位；轨迹面板据此判断断档 */
  lastEventSeq?: number | null;
}

export interface SessionState {
  msgs: Message[];
  acts: Activity[];
  turns: TraceTurn[];
  busy: boolean;
  pendingPerm: PermissionRequest | null;
  /** 当前会话最近一次恢复判定的结果；无标记 = 新会话/未恢复 */
  resume?: SessionResumeState | null;
  /** 这次打开会话的连接失败；成功连接后清空，不落库 */
  connectError?: { code: string; message: string } | null;
  /**
   * 后端推送的写提示：键是 ACP 会话 id（群聊里每个成员一个），只用于显示，不参与发送拦截。
   * 用映射而不是单个槽位，是因为多个 agent 可能同时在写。
   */
  locks?: Record<string, { playerId: string | null; title: string; count: number }>;
  /** ACP 报上来的真实上下文占用；null = 这个会话还没收到过 usage。 */
  usage?: { used: number; size: number; percent: number } | null;
}

/* ---------- 设置 ---------- */
/** 自动同意档：off = agent 提问时始终交给人；edits = 编辑类（edit/delete/move）替你答。 */
export type AutoApproveLevel = "off" | "edits";

export interface ThreadSettings {
  /** @ 玩家时附带最近 N 条群聊记录，默认 5 */
  contextMessages: number;
  theme: ThemeMode;
  /** 新会话默认自动同意档；`off` = 不替用户答，`edits` = 编辑类自动答 */
  autoApproveDefault: AutoApproveLevel;
}

export const CONTEXT_MESSAGES_MAX = 20;
export const CONTEXT_MESSAGES_DEFAULT = 5;
export const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  contextMessages: CONTEXT_MESSAGES_DEFAULT,
  theme: "dark",
  autoApproveDefault: "off",
};

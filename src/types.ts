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
  /** 启动命令，v1 固定 hermes acp，但显式写出来而不是藏在代码里 */
  program?: string;
  args?: string[];
  /** WSL 场景 */
  distro?: string;
  shell?: string;
}

/** ACP 之外的能力（agent 自己的 CLI），不属于协议本体 */
export interface AgentCommand {
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
  /** 人类可读的"最后活动时间"（展示用，由 updatedAtSec 格式化而来） */
  updatedAt: string;
  /** 库里的时间戳（秒），排序与分组都按它算 */
  updatedAtSec?: number;
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
  | "permission";

export type ActivityStatus = "running" | "ok" | "error";

export interface Activity {
  id: string;
  playerId: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
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
export interface TraceTurn {
  id: string;
  at: string;
  userText: string;
  branches: TraceBranch[];
}

/* ---------- 聊天流：只留「人对人的话」 ---------- */
export type Message =
  | { id: string; role: "user"; text: string; at: string; quoted?: QuotedRef }
  | { id: string; role: "player"; playerId: string; text: string; at: string; streaming?: boolean }
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
  title: string;
  detail: string;
  meta?: string;
  options: PermissionOption[];
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
export interface SessionState {
  msgs: Message[];
  acts: Activity[];
  turns: TraceTurn[];
  busy: boolean;
  pendingPerm: PermissionRequest | null;
}

/* ---------- 设置 ---------- */
export interface ThreadSettings {
  /** @ 玩家时附带最近 N 条群聊记录，默认 5 */
  contextMessages: number;
}

//! 域模型与 DTO：前端只描述形状，不写规则。

interface EventRoute {
  /** ACP 会话 id */
  sessionId?: string | null;
  /** 该投给哪个界面会话 */
  uiSessionId?: string | null;
  /** 发言者：群成员 id；主 agent 时为 null */
  authorId?: string | null;
}

export type AcpEvent =
  | ({ kind: "notification"; method: string; params: unknown } & EventRoute)
  | ({ kind: "request"; id: number; method: string; params: unknown } & EventRoute)
  | { kind: "hello" }
  | { kind: "exited" }
  | ({ kind: "promptStarted"; } & EventRoute & { sessionId: string })
  | ({ kind: "promptResult"; result: unknown } & EventRoute & { sessionId: string })
  | ({ kind: "promptFailed"; msg: string } & EventRoute & { sessionId: string });

export interface SessionInfo {
  sessionId: string;
}

export interface ProfileDto {
  id: string;
  name: string;
  launch: string;
  program: string;
  args: string[];
  cwd: string;
  defaultMode?: string | null;
  distro?: string | null;
  shell?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuth?: string | null;
  sshKeyPath?: string | null;
  sshPassword?: string | null;
}

export interface ConnectOutcome {
  /** 本次连接落到的会话（复用旧的或新建的）；handshake 通了但建会话失败时为 undefined */
  sessionId?: string;
  agentName: string;
  agentVersion: string;
  protocolVersion: number;
  loadSession: boolean;
  imagePrompts: boolean;
  authMethods: string[];
  /** 协议能力键，来自 initialize 的 agentCapabilities */
  capabilities: string[];
  modes?: ModesSnapshot | null;
}

export interface ModeOption {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * 打开/恢复会话时 agent 报上来的模式快照。
 * `current` 是 agent 当时的生效值 —— 界面初值必须用它，
 * 不能拿 available[0] 顶（规范 §5.2：跟随且没有连接默认时要显示 agent 的值）。
 */

export interface ModesSnapshot {
  available: ModeOption[];
  current: string;
}

export interface ModeChoice {
  applied: string | null;
  following: boolean;
  warning?: string | null;
}

export type RespondOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface ProbeOutcome {
  agentName: string;
  agentVersion: string;
  protocolVersion: number;
  loadSession: boolean;
  /** 握手报上来的能力键；保存连接之前就能看到这个 agent 支持什么 */
  capabilities: string[];
}

/**
 * 只握手、不保留进程：用来回答「这条命令到底是不是 ACP agent」。
 * 命令写得对不对、装没装、要不要登录，都会在这里暴露出来。
 */

export type AcpMode = "native" | "adapter";

export interface DiscoveryCandidate {
  id: string;
  name: string;
  /** 判断「装没装」用的命令名 */
  binary: string;
  mode: AcpMode;
  /** 真起服务端的命令 */
  acpProgram: string;
  acpArgs: string[];
  note: string;
}

export interface DiscoveryHit {
  candidateId: string;
  /** `local` / `wsl:<distro>` / `ssh:<host>` */
  host: string;
  path: string;
  home: string | null;
}

export interface DiscoveryOutcome {
  scannedAt: number;
  candidates: DiscoveryCandidate[];
  found: DiscoveryHit[];
  /** 某些环境没扫成（wsl.exe 不在之类）：要让用户看到，而不是静默少几行 */
  warnings: string[];
}

/**
 * 扫一遍机器：这台机器上哪些 agent 能当 ACP 服务端跑。
 *
 * 只回答「装没装」。装了的也不一定能用 —— `codex` 在 PATH 上不代表它能起 ACP
 * （实测没有 acp 子命令，要靠适配器）。要确认能不能握手，得用 agentProbe。
 */

export interface AgentUser {
  id: string;
  profileId: string;
  /** 投递地址：该成员在自己那条连接上的 ACP 会话 */
  acpSessionId: string;
  name: string;
  /** @ 用的短名，大小写不敏感、全局唯一 */
  handle: string;
  color: string;
  createdAt: number;
}

export interface AgentUserTestResult {
  ok: boolean;
  /** 成功是会话信息，失败是**原因** */
  detail: string;
}

/**
 * 测试一个 sessionId 能不能当玩家：真跑 `session/load`。
 * 不用 session/list 判断 —— 它只回 agent 记着的列表，判不出「这个 id 能不能恢复」。
 */

export interface SessionRowDto {
  id: string;
  acpSessionId?: string | null;
  modeOverride?: string | null;
  profileId?: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRowDto {
  id: string;
  seq: number;
  role: string;
  kind: string;
  payload: unknown;
  createdAt: number;
}

export interface SessionUpdate {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    currentModeId?: string;
    content?: { type?: string; text?: string };
    [k: string]: unknown;
  };
}

/** 从 notification 里取出 session/update 载荷；不是就返回 null */

export interface WireEvent {
  v: number;
  seq: number;
  ts: number;
  topic: string;
  profileId?: string;
  sessionId?: string;
  uiSessionId?: string;
  authorId?: string;
  lossless: boolean;
  payload: unknown;
}

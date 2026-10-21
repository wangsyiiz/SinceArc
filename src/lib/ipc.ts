import type { AgentProfile, SshAuth, SshConfig } from "@/types";

/**
 * Tauri command 的薄封装。
 *
 * 在浏览器里（`vite dev` 直开）没有 `__TAURI_INTERNALS__`，invoke 会抛 ——
 * 这里提前判掉，给一句能看懂的话，而不是让调用方收到 "undefined is not a function"。
 */

export interface CmdError {
  code: number;
  msg: string;
}

/** 后端推来的事件。tag = kind，与 Rust 的 AcpEvent 对齐 */
export type AcpEvent =
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "request"; id: number; method: string; params: unknown }
  | { kind: "hello" }
  | { kind: "exited" }
  | { kind: "promptStarted"; sessionId: string }
  | { kind: "promptResult"; sessionId: string; result: unknown }
  | { kind: "promptFailed"; sessionId: string; msg: string };

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

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw { code: 50900, msg: "当前不在 Tauri 运行环境里（浏览器直开无法调用后端）" } as CmdError;
  }
  const { invoke: raw } = await import("@tauri-apps/api/core");
  return raw<T>(cmd, args);
}

/** 内部 AgentProfile → 后端 DTO（字段名与 serde 的 camelCase 对齐） */
function toDto(p: AgentProfile) {
  return {
    id: p.id,
    name: p.name,
    launch: p.launch,
    program: p.program ?? "hermes",
    args: p.args ?? ["acp"],
    cwd: p.cwd ?? "",
    defaultMode: p.defaultMode ?? null,
    distro: p.distro ?? "fedora",
    shell: p.shell ?? "zsh",
    sshHost: p.ssh?.host,
    sshPort: p.ssh?.port ?? 22,
    sshUser: p.ssh?.user,
    sshAuth: p.ssh?.auth,
    sshKeyPath: p.ssh?.keyPath,
    sshPassword: p.ssh?.password,
  };
}

/** 库里的配置读回来：DTO 是扁平的，还原成界面用的 AgentProfile */
export function fromDto(d: ProfileDto): AgentProfile {
  const ssh: SshConfig | undefined =
    d.launch === "ssh" && d.sshHost
      ? {
          host: d.sshHost,
          port: d.sshPort ?? 22,
          user: d.sshUser ?? "",
          auth: (d.sshAuth as SshAuth) ?? "key",
          keyPath: d.sshKeyPath ?? undefined,
          // 密码不在库里，重连时需要重新填
          password: undefined,
        }
      : undefined;

  return {
    id: d.id,
    name: d.name,
    launch: d.launch as AgentProfile["launch"],
    detail:
      d.launch === "ssh"
        ? `${d.sshUser ?? "?"}@${d.sshHost ?? "?"}`
        : d.launch === "wsl"
          ? `${d.distro ?? "wsl"} · ${d.program}`
          : d.program,
    connected: false,
    cwd: d.cwd,
    defaultMode: d.defaultMode ?? null,
    program: d.program,
    args: d.args,
    distro: d.distro ?? undefined,
    shell: d.shell ?? undefined,
    ssh,
  };
}

export async function connectAgent(
  profile: AgentProfile,
  onEvent?: (e: AcpEvent) => void,
): Promise<ConnectOutcome> {
  if (!isTauri()) {
    throw { code: 50900, msg: "当前不在 Tauri 运行环境里（浏览器直开无法调用后端）" } as CmdError;
  }
  const { Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<AcpEvent>();
  if (onEvent) channel.onmessage = onEvent;
  return invoke<ConnectOutcome>("agent_connect", { profile: toDto(profile), onEvent: channel });
}

export function sessionNew(profileId: string, cwd: string): Promise<SessionInfo> {
  return invoke<SessionInfo>("session_new", { profileId, cwd });
}

/** 发一轮消息。立即返回：内容从事件流回来，不在这里等生成完。 */
export function sessionPrompt(sessionId: string, text: string): Promise<void> {
  return invoke<void>("session_prompt", { sessionId, text });
}

/** 读回本机存的连接配置 */
export function profilesLoad(): Promise<ProfileDto[]> {
  return invoke<ProfileDto[]>("profiles_load", {});
}

/** 整表覆盖保存（后端会剥掉 SSH 密码，密码永不落盘） */
export function profilesSave(profiles: AgentProfile[]): Promise<void> {
  return invoke<void>("profiles_save", { profiles: profiles.map(toDto) });
}

/* ---------- 会话与消息 ---------- */

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

export function sessionsList(profileId?: string): Promise<SessionRowDto[]> {
  return invoke<SessionRowDto[]>("sessions_list", { profileId: profileId ?? null });
}

export function sessionUpsert(row: SessionRowDto): Promise<void> {
  return invoke<void>("session_upsert", { row });
}

export function sessionDelete(id: string): Promise<void> {
  return invoke<void>("session_delete", { id });
}

/** 把 ACP 会话绑到某个 UI 会话上（一处绑定，之后按它归属事件） */
export function sessionBindAcp(id: string, acpSessionId: string): Promise<void> {
  return invoke<void>("session_bind_acp", { id, acpSessionId });
}

export function messagesAppend(
  sessionId: string,
  messages: { id: string; role: string; kind?: string; payload: unknown }[],
): Promise<void> {
  return invoke<void>("messages_append", { sessionId, messages });
}

export function messagesLoad(sessionId: string, limit?: number): Promise<MessageRowDto[]> {
  return invoke<MessageRowDto[]>("messages_load", { sessionId, limit: limit ?? null });
}

/* ---------- session/update 的解析 ---------- */

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
export function asSessionUpdate(e: AcpEvent): SessionUpdate | null {
  if (e.kind !== "notification" || e.method !== "session/update") return null;
  return (e.params as SessionUpdate) ?? null;
}

export function disconnectAgent(profileId: string): Promise<void> {
  return invoke<void>("agent_disconnect", { profileId });
}

export function sessionApplyMode(
  profileId: string,
  acpSessionId: string,
  uiSessionId: string,
): Promise<ModeChoice> {
  return invoke<ModeChoice>("session_apply_mode", { profileId, acpSessionId, uiSessionId });
}

export function sessionChooseMode(
  profileId: string,
  acpSessionId: string,
  uiSessionId: string,
  modeId: string | null,
): Promise<ModeChoice> {
  return invoke<ModeChoice>("session_choose_mode", {
    profileId,
    acpSessionId,
    uiSessionId,
    modeId,
  });
}

export function listConnected(): Promise<string[]> {
  return invoke<string[]>("agent_list_connected");
}

export function asCmdError(e: unknown): CmdError {
  if (e && typeof e === "object" && "code" in e && "msg" in e) return e as CmdError;
  return { code: 50000, msg: e instanceof Error ? e.message : String(e) };
}

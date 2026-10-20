import type { AgentProfile } from "@/types";

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
  | { kind: "exited" };

export interface SessionInfo {
  sessionId: string;
}

export interface ConnectOutcome {
  agentName: string;
  agentVersion: string;
  protocolVersion: number;
  loadSession: boolean;
  imagePrompts: boolean;
  authMethods: string[];
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

export function disconnectAgent(profileId: string): Promise<void> {
  return invoke<void>("agent_disconnect", { profileId });
}

export function listConnected(): Promise<string[]> {
  return invoke<string[]>("agent_list_connected");
}

export function asCmdError(e: unknown): CmdError {
  if (e && typeof e === "object" && "code" in e && "msg" in e) return e as CmdError;
  return { code: 50000, msg: e instanceof Error ? e.message : String(e) };
}

export type ThemeMode = "dark" | "light" | "system";

export type LaunchKind = "wsl" | "local";

export interface AgentProfile {
  id: string;
  name: string;
  launch: LaunchKind;
  /** 人类可读的连接描述，例如 "fedora · hermes acp" */
  detail: string;
  connected: boolean;
  /** 由 initialize 握手得到；未接线时为 null */
  agentName?: string | null;
  protocolVersion?: number | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  group: "今天" | "昨天" | "更早";
}

export type ToolKind = "read" | "edit" | "execute" | "search" | "other";
export type ToolStatus = "pending" | "running" | "ok" | "error";

export interface ToolCall {
  id: string;
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  detail?: string;
  meta?: string;
}

export type Message =
  | { id: string; role: "user"; kind: "text"; text: string; at: string }
  | { id: string; role: "agent"; kind: "text"; text: string; at: string; streaming?: boolean }
  | { id: string; role: "agent"; kind: "thinking"; text: string; at: string }
  | { id: string; role: "agent"; kind: "tool_call"; call: ToolCall; at: string }
  | { id: string; role: "system"; kind: "notice"; text: string; at: string };

export interface PermissionOption {
  id: string;
  label: string;
  tone: "allow" | "always" | "reject";
}

export interface PermissionRequest {
  id: string;
  title: string;
  detail: string;
  meta?: string;
  options: PermissionOption[];
}

export interface SessionState {
  sessionId: string | null;
  cwd: string;
  messages: Message[];
  pending: PermissionRequest | null;
  busy: boolean;
}

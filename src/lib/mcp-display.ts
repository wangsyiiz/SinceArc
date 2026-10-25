import type { AgentCaps } from "./ipc/types.gen/AgentCaps";
import type { McpCatalogEntryDto } from "./ipc/types.gen/McpCatalogEntryDto";
import type { McpKeyValueDto } from "./ipc/types.gen/McpKeyValueDto";
import type { McpServerDto } from "./ipc/types.gen/McpServerDto";

export type McpKind = "stdio" | "http" | "sse";

export interface McpServerFields {
  kind: McpKind;
  name: string;
  command: string;
  args: string[];
  url: string;
  env: McpKeyValueDto[];
  headers: McpKeyValueDto[];
}

export function asMcpKind(value: string): McpKind | null {
  return value === "stdio" || value === "http" || value === "sse" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pairs(value: unknown): McpKeyValueDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{ name: stringValue(item.name), value: stringValue(item.value) }];
  });
}

/**
 * 后端 IPC 的运行时形状是扁平的（stdio 没有 type，http/sse 带 type）。
 * ts-rs 对 enum 生成的声明却是 `{ Stdio: … }`，所以这里同时兼容两种形状，
 * 避免界面把真实数据读成空白。
 */
export function serverFields(server: McpServerDto): McpServerFields {
  const raw = server as unknown as Record<string, unknown>;
  const variant = (["Stdio", "Http", "Sse"] as const).find((key) => isRecord(raw[key]));
  const value = variant ? (raw[variant] as Record<string, unknown>) : raw;
  const typedKind = asMcpKind(stringValue(value.type));
  const kind = typedKind ?? (variant === "Http" ? "http" : variant === "Sse" ? "sse" : "stdio");
  return {
    kind,
    name: stringValue(value.name),
    command: stringValue(value.command),
    args: stringArray(value.args),
    url: stringValue(value.url),
    env: pairs(value.env),
    headers: pairs(value.headers),
  };
}

export function entryKind(entry: McpCatalogEntryDto): McpKind {
  return asMcpKind(entry.kind) ?? serverFields(entry.server).kind;
}

/** 单行展示文本；超长时保留可辨认的开头并加省略号。 */
export function describeServer(entry: McpCatalogEntryDto, maxLength = 88): string {
  const fields = serverFields(entry.server);
  const kind = entryKind(entry);
  const raw =
    kind === "stdio"
      ? [fields.command, ...fields.args].filter((part) => part.trim().length > 0).join(" ")
      : fields.url;
  return truncateText(raw || entry.name, maxLength);
}

export function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * 只做标注，不做禁用：未声明不等于不支持（docs/mcp.md §11.1）。
 * 没有握手快照时不猜。
 */
export function transportSupportNote(kind: string, caps: AgentCaps | null): string | null {
  if (!caps) return null;
  if (kind === "http" && !caps.mcpHttp) return "agent 未声明支持";
  if (kind === "sse" && !caps.mcpSse) return "agent 未声明支持";
  return null;
}

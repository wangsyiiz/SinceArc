import { invokeCmd } from "../client";
import type { McpCatalogEntryDto } from "../types.gen/McpCatalogEntryDto";
import type { McpServerDto } from "../types.gen/McpServerDto";
import type { SessionMcpStateDto } from "../types.gen/SessionMcpStateDto";

export function mcpCatalog(): Promise<McpCatalogEntryDto[]> {
  return invokeCmd<McpCatalogEntryDto[]>("mcp_catalog", {});
}

export function mcpUpsert(server: McpServerDto): Promise<void> {
  return invokeCmd<void>("mcp_upsert", { server });
}

export function mcpDelete(name: string): Promise<void> {
  return invokeCmd<void>("mcp_delete", { name });
}

export function sessionSetMcpNames(
  uiSessionId: string,
  names: string[] | null,
): Promise<void> {
  return invokeCmd<void>("session_set_mcp_names", { uiSessionId, names });
}

export function profileSetDefaultMcp(
  profileId: string,
  names: string[] | null,
): Promise<void> {
  return invokeCmd<void>("profile_set_default_mcp", { profileId, names });
}

export function sessionMcpState(uiSessionId: string): Promise<SessionMcpStateDto> {
  return invokeCmd<SessionMcpStateDto>("session_mcp_state", { uiSessionId });
}

import type { AgentCaps } from "@/lib/ipc/types.gen/AgentCaps";
import type { MessageKey } from "@/i18n/zh-CN";

export type CapsGroup = "input" | "session" | "mcp";

export interface CapsRow {
  group: CapsGroup;
  key: keyof AgentCaps;
  labelKey: MessageKey;
  on: boolean;
  /** 面板里的状态码：MCP 的 false 是「未声明」，不是「不支持」。 */
  display: "on" | "off" | "undeclared";
}

/** 分组与组内顺序都是固定的：面板和探测结果共用同一份，避免两处各排一套。 */
const ROWS: Omit<CapsRow, "on" | "display">[] = [
  { group: "input", key: "promptImage", labelKey: "settings.caps.promptImage" },
  { group: "input", key: "promptAudio", labelKey: "settings.caps.promptAudio" },
  { group: "input", key: "promptEmbeddedContext", labelKey: "settings.caps.promptEmbeddedContext" },
  { group: "session", key: "loadSession", labelKey: "settings.caps.loadSession" },
  { group: "session", key: "sessionList", labelKey: "settings.caps.sessionList" },
  { group: "session", key: "sessionDelete", labelKey: "settings.caps.sessionDelete" },
  { group: "session", key: "sessionFork", labelKey: "settings.caps.sessionFork" },
  { group: "session", key: "sessionResume", labelKey: "settings.caps.sessionResume" },
  { group: "session", key: "sessionClose", labelKey: "settings.caps.sessionClose" },
  { group: "mcp", key: "mcpHttp", labelKey: "settings.caps.mcpHttp" },
  { group: "mcp", key: "mcpSse", labelKey: "settings.caps.mcpSse" },
  { group: "mcp", key: "mcpAcp", labelKey: "settings.caps.mcpAcp" },
];

/** `null` = 还没握手过：返回空数组，让调用方说「还没连过」而不是编一张全 false 的表。 */
export function capsRows(caps: AgentCaps | null): CapsRow[] {
  if (!caps) return [];
  return ROWS.map((row) => {
    const on = caps[row.key];
    return {
      ...row,
      on,
      display: on ? "on" : row.group === "mcp" ? "undeclared" : "off",
    };
  });
}

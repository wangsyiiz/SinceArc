import type { AgentCaps } from "@/lib/ipc/types.gen/AgentCaps";

export type CapsGroup = "输入" | "会话" | "MCP";

export interface CapsRow {
  group: CapsGroup;
  key: keyof AgentCaps;
  label: string;
  on: boolean;
}

/** 分组与组内顺序都是固定的：面板和探测结果共用同一份，避免两处各排一套。 */
const ROWS: Omit<CapsRow, "on">[] = [
  { group: "输入", key: "promptImage", label: "图片输入" },
  { group: "输入", key: "promptAudio", label: "音频输入" },
  { group: "输入", key: "promptEmbeddedContext", label: "嵌入上下文" },
  { group: "会话", key: "loadSession", label: "恢复历史会话" },
  { group: "会话", key: "sessionList", label: "会话列表" },
  { group: "会话", key: "sessionDelete", label: "删除会话" },
  { group: "会话", key: "sessionFork", label: "会话分叉" },
  { group: "会话", key: "sessionResume", label: "会话续跑" },
  { group: "会话", key: "sessionClose", label: "关闭会话" },
  { group: "MCP", key: "mcpHttp", label: "MCP over HTTP" },
  { group: "MCP", key: "mcpSse", label: "MCP over SSE" },
  { group: "MCP", key: "mcpAcp", label: "MCP over ACP" },
];

/** `null` = 还没握手过：返回空数组，让调用方说「还没连过」而不是编一张全 false 的表。 */
export function capsRows(caps: AgentCaps | null): CapsRow[] {
  if (!caps) return [];
  return ROWS.map((row) => ({ ...row, on: caps[row.key] }));
}

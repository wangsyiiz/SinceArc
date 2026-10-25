/**
 * MCP 目录编辑态：只记录「哪一行在编辑」或「正在新增」。
 *
 * 表单内容仍在组件里；这里只保证同一时刻最多一个编辑目标，
 * 点另一行的编辑时直接切换过去，取消回到无编辑态。
 */
export type McpCatalogEditor =
  | { mode: "none" }
  | { mode: "add" }
  | { mode: "edit"; name: string };

export type McpCatalogEditorAction =
  | { type: "add" }
  | { type: "edit"; name: string }
  | { type: "close" };

export const MCP_CATALOG_EDITOR_CLOSED: McpCatalogEditor = { mode: "none" };

export function mcpCatalogEditorReducer(
  _state: McpCatalogEditor,
  action: McpCatalogEditorAction,
): McpCatalogEditor {
  switch (action.type) {
    case "add":
      return { mode: "add" };
    case "edit":
      return { mode: "edit", name: action.name };
    case "close":
      return MCP_CATALOG_EDITOR_CLOSED;
  }
}

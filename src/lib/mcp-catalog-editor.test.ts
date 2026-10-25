import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_CATALOG_EDITOR_CLOSED,
  mcpCatalogEditorReducer,
  type McpCatalogEditor,
} from "./mcp-catalog-editor.ts";

test("点编辑进入对应行，点另一行会切换且只保留一个编辑目标", () => {
  const first = mcpCatalogEditorReducer(MCP_CATALOG_EDITOR_CLOSED, {
    type: "edit",
    name: "fs",
  });
  assert.deepEqual(first, { mode: "edit", name: "fs" });

  const switched = mcpCatalogEditorReducer(first, { type: "edit", name: "remote" });
  assert.deepEqual(switched, { mode: "edit", name: "remote" });
});

test("取消回到无编辑态", () => {
  const editing: McpCatalogEditor = { mode: "edit", name: "fs" };
  assert.deepEqual(mcpCatalogEditorReducer(editing, { type: "close" }), {
    mode: "none",
  });
});

test("新增与编辑互斥，始终只有一个编辑目标", () => {
  const adding = mcpCatalogEditorReducer(MCP_CATALOG_EDITOR_CLOSED, { type: "add" });
  assert.deepEqual(adding, { mode: "add" });
  assert.deepEqual(mcpCatalogEditorReducer(adding, { type: "edit", name: "fs" }), {
    mode: "edit",
    name: "fs",
  });
  assert.deepEqual(mcpCatalogEditorReducer(adding, { type: "add" }), { mode: "add" });
});

import { parseMarkdown, type Block, type Inline } from "../markdown.ts";

/** §19.4 的初值；真实高度由 measureElement 覆盖。 */
export const MESSAGE_ESTIMATE_HEIGHT = {
  text: 72,
  code: 200,
  table: 260,
  imageOrTrace: 240,
} as const;

export interface MessageBlockLike {
  kind?: string;
  blocks?: readonly MessageBlockLike[];
}

export interface MessageEstimateInput {
  text?: string;
  atomKind?: string;
  /** 兼容以后由权威消息结构直接带下来的块；当前 Message 类型没有该字段。 */
  blocks?: readonly MessageBlockLike[];
}

function collectBlockKinds(blocks: readonly MessageBlockLike[], kinds: Set<string>): void {
  for (const block of blocks) {
    if (typeof block.kind === "string") kinds.add(block.kind);
    if (block.blocks) collectBlockKinds(block.blocks, kinds);
  }
}

function inlineHasImage(inlines: readonly Inline[]): boolean {
  for (const inline of inlines) {
    if (inline.kind === "text" && inline.text.includes("[图片]")) return true;
    if ("children" in inline && inlineHasImage(inline.children)) return true;
  }
  return false;
}

function blockHasImage(block: Block): boolean {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return inlineHasImage(block.children);
    case "list":
      return block.items.some((item) => item.some(blockHasImage));
    case "quote":
      return block.blocks.some(blockHasImage);
    default:
      return false;
  }
}

function hasMarkdownBlockSyntax(text: string): boolean {
  return text.includes("```") || text.includes("~~~") || text.includes("![") || text.includes("|");
}

export function estimateMessageHeight(message?: MessageEstimateInput | null): number {
  const text = typeof message?.text === "string" ? message.text : "";
  const kinds = new Set<string>();
  if (message?.atomKind) kinds.add(message.atomKind);
  if (message?.blocks) collectBlockKinds(message.blocks, kinds);

  let blocks: readonly Block[] = [];
  if (!message?.blocks && hasMarkdownBlockSyntax(text)) blocks = parseMarkdown(text);

  const hasTable = kinds.has("table") || blocks.some((block) => block.kind === "table");
  if (hasTable) return MESSAGE_ESTIMATE_HEIGHT.table;

  const hasImageOrTrace =
    kinds.has("image") ||
    kinds.has("trace") ||
    kinds.has("trace.card") ||
    blocks.some(blockHasImage);
  if (hasImageOrTrace) return MESSAGE_ESTIMATE_HEIGHT.imageOrTrace;

  const hasCode = kinds.has("code") || blocks.some((block) => block.kind === "code");
  if (hasCode) return MESSAGE_ESTIMATE_HEIGHT.code;

  return MESSAGE_ESTIMATE_HEIGHT.text;
}

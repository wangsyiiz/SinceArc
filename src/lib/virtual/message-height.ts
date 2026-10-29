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
  id?: string;
  text?: string;
  atomKind?: string;
  /** 兼容以后由权威消息结构直接带下来的块；当前 Message 类型没有该字段。 */
  blocks?: readonly MessageBlockLike[];
}

export type HeightClass = "text" | "code" | "table" | "media";

/** 每个消息 id 只算一次。键是消息 id，不落库。 */
/** 分类缓存上限。跨会话累积也不该无限长；清空只多算一轮，不影响正确性。 */
const HEIGHT_CACHE_LIMIT = 20_000;
const heightClassCache = new Map<string, HeightClass>();

/** 测试用：清空估算缓存，避免用例之间互相污染。 */
export function __resetHeightClassCache(): void {
  heightClassCache.clear();
}

function collectBlockKinds(blocks: readonly MessageBlockLike[], kinds: Set<string>): void {
  for (const block of blocks) {
    if (typeof block.kind === "string") kinds.add(block.kind);
    if (block.blocks) collectBlockKinds(block.blocks, kinds);
  }
}

function inlineHasImage(inlines: readonly Inline[]): boolean {
  for (const inline of inlines) {
    if (inline.kind === "text" && inline.text.includes("[图片]")) return true; // i18n-ignore: 与 markdown 哨兵保持一致
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

function heightOfClass(kind: HeightClass): number {
  switch (kind) {
    case "table":
      return MESSAGE_ESTIMATE_HEIGHT.table;
    case "media":
      return MESSAGE_ESTIMATE_HEIGHT.imageOrTrace;
    case "code":
      return MESSAGE_ESTIMATE_HEIGHT.code;
    default:
      return MESSAGE_ESTIMATE_HEIGHT.text;
  }
}

function classifyMessageHeight(message?: MessageEstimateInput | null): HeightClass {
  const kinds = new Set<string>();
  if (message?.atomKind) kinds.add(message.atomKind);
  if (message?.blocks) collectBlockKinds(message.blocks, kinds);

  // atomKind / blocks 已经给出结论时不再看正文；正文只在确实需要时才解析。
  if (kinds.has("table")) return "table";
  if (
    kinds.has("image") ||
    kinds.has("media") ||
    kinds.has("trace") ||
    kinds.has("trace.card")
  ) {
    return "media";
  }
  if (kinds.has("code")) return "code";

  // 正文只读一次：`typeof message?.text === "string" ? message.text : ""` 会触发两次 getter，
  // 而 estimate 每帧被调 O(n) 次，这种"多读一次"在热路径上是要还的。
  const rawText = message?.text;
  const text = typeof rawText === "string" ? rawText : "";
  let blocks: readonly Block[] = [];
  if (!message?.blocks && hasMarkdownBlockSyntax(text)) blocks = parseMarkdown(text);

  if (blocks.some((block) => block.kind === "table")) return "table";

  if (blocks.some(blockHasImage)) return "media";

  if (blocks.some((block) => block.kind === "code")) return "code";

  return "text";
}

export function estimateMessageHeight(message?: MessageEstimateInput | null): number {
  const id = typeof message?.id === "string" && message.id.length > 0 ? message.id : null;
  if (id) {
    const cached = heightClassCache.get(id);
    if (cached) return heightOfClass(cached);

    const kind = classifyMessageHeight(message);
    // 上限只为防"跨会话累积"，不是性能开关：清空只会让下一轮重新分类一次。
    if (heightClassCache.size >= HEIGHT_CACHE_LIMIT) heightClassCache.clear();
    heightClassCache.set(id, kind);
    return heightOfClass(kind);
  }

  return heightOfClass(classifyMessageHeight(message));
}

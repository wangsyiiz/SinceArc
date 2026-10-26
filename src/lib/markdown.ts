import { marked } from "marked";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; depth: number; children: Inline[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][]; task?: boolean }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "hr" };

type RawToken = Record<string, unknown> & { type?: unknown };

function asToken(value: unknown): RawToken | null {
  return typeof value === "object" && value !== null ? (value as RawToken) : null;
}

function tokenList(value: unknown): RawToken[] {
  if (!Array.isArray(value)) return [];
  return value.map(asToken).filter((token): token is RawToken => token !== null);
}

function tokenType(token: RawToken): string {
  return typeof token.type === "string" ? token.type : "";
}

function tokenText(token: RawToken): string {
  if (typeof token.text === "string") return token.text;
  if (typeof token.raw === "string") return token.raw;
  return "";
}

function textInline(text: string): Inline[] {
  return text ? [{ kind: "text", text }] : [];
}

function childrenOf(token: RawToken): Inline[] {
  const nested = tokenList(token.tokens);
  if (nested.length > 0) return parseInlines(nested);
  return textInline(tokenText(token));
}

function fallbackBlock(token: RawToken): Block | null {
  const children = textInline(tokenText(token));
  return children.length > 0 ? { kind: "paragraph", children } : null;
}

function paragraphOf(token: RawToken): Block | null {
  const nested = tokenList(token.tokens);
  const children = nested.length > 0 ? parseInlines(nested) : textInline(tokenText(token));
  return children.length > 0 ? { kind: "paragraph", children } : null;
}

function normalizeStart(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function withTaskMarker(blocks: Block[], checked: boolean): Block[] {
  const marker: Inline = { kind: "text", text: checked ? "☑ " : "☐ " };
  const first = blocks[0];
  if (first?.kind === "paragraph") {
    return [{ kind: "paragraph", children: [marker, ...first.children] }, ...blocks.slice(1)];
  }
  return [{ kind: "paragraph", children: [marker] }, ...blocks];
}

function listItemBlocks(token: RawToken, task: boolean): Block[] {
  const tokens = tokenList(token.tokens).filter((item) => tokenType(item) !== "checkbox");
  const blocks = parseBlocks(tokens);
  return task ? withTaskMarker(blocks, token.checked === true) : blocks;
}

function parseList(token: RawToken): Block {
  let task = false;
  const items = tokenList(token.items).map((item) => {
    const isListItem = tokenType(item) === "list_item";
    const itemTask = isListItem && item.task === true;
    if (itemTask) task = true;
    if (isListItem) return listItemBlocks(item, itemTask);

    const fallback = fallbackBlock(item);
    return fallback ? [fallback] : [];
  });

  return {
    kind: "list",
    ordered: token.ordered === true,
    start: normalizeStart(token.start),
    items,
    ...(task ? { task: true } : {}),
  };
}

function normalizeAlign(value: unknown): Align {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function cellInlines(cell: RawToken | undefined): Inline[] {
  if (!cell) return [];
  const nested = tokenList(cell.tokens);
  if (nested.length > 0) return parseInlines(nested);
  return textInline(tokenText(cell));
}

function parseTable(token: RawToken): Block {
  const rawHeader = tokenList(token.header);
  const rawRows = (Array.isArray(token.rows) ? token.rows : []).map((row) => tokenList(row));
  const rawAlign = Array.isArray(token.align) ? token.align : [];
  const columnCount = Math.max(
    rawHeader.length,
    rawAlign.length,
    ...rawRows.map((row) => row.length),
    0,
  );

  const align = Array.from({ length: columnCount }, (_, index) => normalizeAlign(rawAlign[index]));
  const header = Array.from({ length: columnCount }, (_, index) => cellInlines(rawHeader[index]));
  const rows = rawRows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => cellInlines(row[index])),
  );

  return { kind: "table", align, header, rows };
}

function parseBlock(token: RawToken): Block | null {
  switch (tokenType(token)) {
    case "space":
      return null;
    case "paragraph":
    case "text":
      return paragraphOf(token);
    case "heading": {
      const depth =
        typeof token.depth === "number" && Number.isFinite(token.depth)
          ? Math.min(6, Math.max(1, Math.trunc(token.depth)))
          : 1;
      return { kind: "heading", depth, children: childrenOf(token) };
    }
    case "code": {
      const text = tokenText(token).replace(/\n+$/, "");
      const lang = typeof token.lang === "string" && token.lang.length > 0 ? token.lang : null;
      return { kind: "code", lang, text };
    }
    case "list":
      return parseList(token);
    case "blockquote": {
      const blocks = parseBlocks(token.tokens);
      const fallback = fallbackBlock(token);
      return { kind: "quote", blocks: blocks.length > 0 ? blocks : fallback ? [fallback] : [] };
    }
    case "table":
      return parseTable(token);
    case "hr":
      return { kind: "hr" };
    default:
      return fallbackBlock(token);
  }
}

function parseBlocks(value: unknown): Block[] {
  const blocks: Block[] = [];
  for (const token of tokenList(value)) {
    const block = parseBlock(token);
    if (block) blocks.push(block);
  }
  return blocks;
}

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const href = value.trim();
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

function imageFallback(token: RawToken): Inline {
  const alt = typeof token.text === "string" ? token.text : "";
  const href = typeof token.href === "string" ? token.href.trim() : "";
  let text = alt ? `[图片] ${alt}` : "[图片]";
  if (href) text += ` — ${href}`;
  return { kind: "text", text };
}

function parseInline(token: RawToken): Inline[] {
  switch (tokenType(token)) {
    case "text": {
      const nested = tokenList(token.tokens);
      return nested.length > 0 ? parseInlines(nested) : textInline(tokenText(token));
    }
    case "escape":
      return textInline(tokenText(token));
    case "strong":
      return [{ kind: "strong", children: childrenOf(token) }];
    case "em":
      return [{ kind: "em", children: childrenOf(token) }];
    case "del":
      return [{ kind: "del", children: childrenOf(token) }];
    case "codespan":
      return [{ kind: "code", text: tokenText(token) }];
    case "br":
      return [{ kind: "br" }];
    case "link": {
      const href = safeHref(token.href);
      const children = childrenOf(token);
      return href ? [{ kind: "link", href, children }] : children;
    }
    case "image":
      return [imageFallback(token)];
    default:
      return textInline(tokenText(token));
  }
}

function parseInlines(value: unknown): Inline[] {
  const inlines: Inline[] = [];
  for (const token of tokenList(value)) inlines.push(...parseInline(token));
  return inlines;
}

export function parseMarkdown(src: string): Block[] {
  if (typeof src !== "string" || src.trim() === "") return [];
  try {
    return parseBlocks(marked.lexer(src, { gfm: true }));
  } catch {
    return [{ kind: "paragraph", children: [{ kind: "text", text: src }] }];
  }
}

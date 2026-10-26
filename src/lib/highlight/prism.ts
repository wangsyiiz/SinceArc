// prismjs 1.30.0 不带类型声明；这里只用到 languages 与 tokenize。
// @ts-expect-error prismjs ships without type declarations
import Prism from "prismjs";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-yaml.js";
import type { Highlighter, HighlightTheme, TokenSpan } from "./types";

export const MAX_HIGHLIGHT_LINES = 500;

/**
 * 对外只认 §18.3 的语言集。这里显式列出 canonical 名与别名，
 * 不拿 `Prism.languages` 里碰巧存在的语言兜底 —— 未标注与未知语言都必须不猜。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  sql: "sql",
  postgres: "sql",
  sqlite: "sql",
  python: "python",
  py: "python",
  rust: "rust",
  css: "css",
  html: "markup",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
};

/** Prism 的语言键；`null` 表示不在 §18.3 的白名单里。 */
export function resolveLanguage(lang: string): string | null {
  const first = lang.trim().toLowerCase().split(/\s+/, 1)[0];
  return LANGUAGE_ALIASES[first] ?? null;
}

export function countCodeLines(code: string): number {
  return code.split(/\r\n|\r|\n/).length;
}

// Prism token type → 我们的语义档位（配色在我们这层，不认库的主题）
const MAP: Record<string, HighlightTheme> = {
  comment: "comment", prolog: "comment", doctype: "comment", cdata: "comment",
  keyword: "keyword", "class-name": "type", builtin: "type", "maybe-class-name": "type",
  boolean: "literal", constant: "literal", symbol: "literal", null: "literal",
  number: "number", string: "string", char: "string", regex: "string", "template-string": "string",
  function: "function", "method": "function", "function-variable": "function",
  operator: "operator", punctuation: "punct",
  property: "type", "attr-name": "type", "attr-value": "string", tag: "keyword",
  selector: "function", rule: "keyword", atrule: "keyword", important: "keyword",
  url: "string", namespace: "type", "literal-property": "type",
};

function flatten(node: unknown, out: TokenSpan[], theme: HighlightTheme = "plain"): void {
  if (typeof node === "string") {
    if (node) out.push({ text: node, theme });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out, theme);
    return;
  }
  if (node && typeof node === "object" && "type" in node && "content" in node) {
    const t = (node as { type: string }).type;
    const next = MAP[t] ?? theme;
    flatten((node as { content: unknown }).content, out, next);
  }
}

function plain(code: string): TokenSpan[] {
  return [{ text: code, theme: "plain" }];
}

export const prismHighlighter: Highlighter = {
  supports(lang) {
    const key = resolveLanguage(lang);
    return key !== null && Boolean(Prism.languages[key]);
  },
  tokenize(code, lang) {
    const key = resolveLanguage(lang);
    const grammar = key === null ? undefined : Prism.languages[key];
    if (!grammar || countCodeLines(code) > MAX_HIGHLIGHT_LINES) return plain(code);
    const out: TokenSpan[] = [];
    flatten(Prism.tokenize(code, grammar), out);
    return out.length > 0 ? out : plain(code);
  },
};

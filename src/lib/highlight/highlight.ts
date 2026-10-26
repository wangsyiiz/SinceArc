import { MAX_HIGHLIGHT_LINES, countCodeLines, prismHighlighter } from "./prism.ts";
import type { TokenSpan } from "./types";

export interface HighlightResult {
  /** Prism 产出的语义 span；降级时只有一个 plain span。 */
  spans: TokenSpan[];
  /** false 表示调用方应按纯文本渲染（未标注、不支持或超过 500 行）。 */
  highlighted: boolean;
  /** 因超过行数上限而降级时的实际行数；其它情况为 null。 */
  omittedLines: number | null;
}

export const HIGHLIGHT_CACHE_LIMIT = 200;

const cache = new Map<string, HighlightResult>();
export const highlightCacheStats = { hits: 0, misses: 0 };

/** 键是 (lang, code)；长度前缀保证语言名里出现分隔符也不会撞键。 */
function cacheKey(lang: string | null | undefined, code: string): string {
  const language = lang?.trim().toLowerCase() ?? "";
  return `${language.length}:${language}${code}`;
}

function readCache(key: string): HighlightResult | undefined {
  const found = cache.get(key);
  if (found === undefined) {
    highlightCacheStats.misses += 1;
    return undefined;
  }
  highlightCacheStats.hits += 1;
  cache.delete(key);
  cache.set(key, found);
  return found;
}

function writeCache(key: string, result: HighlightResult): void {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function highlightCode(
  code: string,
  lang: string | null | undefined,
): HighlightResult {
  const key = cacheKey(lang, code);
  const cached = readCache(key);
  if (cached) return cached;

  const lines = countCodeLines(code);
  let result: HighlightResult;

  if (lines > MAX_HIGHLIGHT_LINES) {
    result = {
      spans: [{ text: code, theme: "plain" }],
      highlighted: false,
      omittedLines: lines,
    };
  } else if (!lang || !prismHighlighter.supports(lang)) {
    result = {
      spans: [{ text: code, theme: "plain" }],
      highlighted: false,
      omittedLines: null,
    };
  } else {
    result = {
      spans: prismHighlighter.tokenize(code, lang),
      highlighted: true,
      omittedLines: null,
    };
  }

  writeCache(key, result);
  return result;
}

export function resetHighlightCache(): void {
  cache.clear();
  highlightCacheStats.hits = 0;
  highlightCacheStats.misses = 0;
}

export function getHighlightCacheStats(): { hits: number; misses: number; size: number } {
  return { ...highlightCacheStats, size: cache.size };
}

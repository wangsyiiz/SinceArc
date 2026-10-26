// 我们自己的高亮契约：调用方只认这个，不认具体库
export type HighlightTheme =
  | "plain" | "comment" | "keyword" | "string" | "number"
  | "literal" | "function" | "type" | "operator" | "punct";

export interface TokenSpan {
  text: string;
  theme: HighlightTheme;
}

export interface Highlighter {
  supports(lang: string): boolean;
  tokenize(code: string, lang: string): TokenSpan[];
}

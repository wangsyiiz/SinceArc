import type { HighlightTheme } from "./types.ts";

/** 语义档位沿用高亮契约里的九档（外加 plain）；不另造档位名。 */
export type TokenKind = HighlightTheme;

export type CodeThemeId =
  | "github-dark"
  | "one-dark"
  | "dracula"
  | "nord"
  | "sincearc";

export interface CodeTheme {
  id: CodeThemeId;
  label: string;
  background: string;
  colors: Record<TokenKind, string>;
}

export const DEFAULT_CODE_THEME_ID: CodeThemeId = "github-dark";

export const CODE_THEMES: readonly CodeTheme[] = [
  {
    id: "github-dark",
    label: "GitHub Dark",
    background: "#0d1117",
    colors: {
      plain: "#e6edf3",
      comment: "#8b949e",
      keyword: "#ff7b72",
      string: "#a5d6ff",
      number: "#79c0ff",
      literal: "#79c0ff",
      function: "#d2a8ff",
      type: "#ffa657",
      operator: "#ff7b72",
      punct: "#e6edf3",
    },
  },
  {
    id: "one-dark",
    label: "One Dark",
    background: "#282c34",
    colors: {
      plain: "#abb2bf",
      comment: "#5c6370",
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      literal: "#56b6c2",
      function: "#61afef",
      type: "#e5c07b",
      operator: "#56b6c2",
      punct: "#abb2bf",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    background: "#282a36",
    colors: {
      plain: "#f8f8f2",
      comment: "#6272a4",
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      literal: "#bd93f9",
      function: "#50fa7b",
      type: "#8be9fd",
      operator: "#ff79c6",
      punct: "#f8f8f2",
    },
  },
  {
    id: "nord",
    label: "Nord",
    background: "#2e3440",
    colors: {
      plain: "#d8dee9",
      comment: "#616e88",
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      literal: "#b48ead",
      function: "#88c0d0",
      type: "#8fbcbb",
      operator: "#81a1c1",
      punct: "#eceff4",
    },
  },
  {
    // 我们的设计语言映射（单色）：与界面同一身份，不是默认。
    // 值取自 :root 令牌：i1 #f6f6f6 / i2 #c0c0c0 / i3 #b2b2b2 / a1 #dedede / s0 #292d3e；
    // 数字是 --warn 70% + --i1 30% 的混色结果（与 §20 之前那套映射等价）。
    id: "sincearc",
    label: "SinceArc",
    background: "#292d3e",
    colors: {
      plain: "#f6f6f6",
      comment: "#b2b2b2",
      keyword: "#dedede",
      string: "#f6f6f6",
      number: "#ddb562",
      literal: "#ddb562",
      function: "#c0c0c0",
      type: "#c0c0c0",
      operator: "#c0c0c0",
      punct: "#c0c0c0",
    },
  },
];

const CODE_THEME_IDS = new Set<string>(CODE_THEMES.map((theme) => theme.id));

export function isCodeThemeId(value: unknown): value is CodeThemeId {
  return typeof value === "string" && CODE_THEME_IDS.has(value);
}

export function normalizeCodeThemeId(value: unknown): CodeThemeId {
  return isCodeThemeId(value) ? value : DEFAULT_CODE_THEME_ID;
}

import type { HighlightTheme } from "./types.ts";

/** 语义档位沿用高亮契约里的九档（外加 plain）；不另造档位名。 */
export type TokenKind = HighlightTheme;

export type CodeThemeId = "github-dark" | "one-dark" | "dracula" | "nord";

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
];

const CODE_THEME_IDS = new Set<string>(CODE_THEMES.map((theme) => theme.id));

export function isCodeThemeId(value: unknown): value is CodeThemeId {
  return typeof value === "string" && CODE_THEME_IDS.has(value);
}

export function normalizeCodeThemeId(value: unknown): CodeThemeId {
  return isCodeThemeId(value) ? value : DEFAULT_CODE_THEME_ID;
}

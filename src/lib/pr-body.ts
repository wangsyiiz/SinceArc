/**
 * PR 正文的纯文本切分：只把 http/https/mailto 认成链接（与 `src/lib/markdown.ts`
 * 的白名单一致），其余一律原样当文本 —— 不渲染 markdown、不碰 HTML。
 */

export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

const LINK = /(mailto:[^\s<>()]+|https?:\/\/[^\s<>()]+)/gi;
/** 句末标点常常紧贴 URL，切下来时留给文本，链接本身不带。 */
const TRAILING = /[.,;:!?]+$/;

export function splitBodyLinks(text: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LINK)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) });
    const raw = match[0];
    const trailing = raw.match(TRAILING)?.[0] ?? "";
    const href = trailing ? raw.slice(0, -trailing.length) : raw;
    segments.push({ kind: "link", text: href, href });
    if (trailing) segments.push({ kind: "text", text: trailing });
    cursor = index + raw.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

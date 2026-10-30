import { anchorTargetScrollTop } from "./virtual/virtual-math.ts";

export interface ScrollAnchor {
  messageId: string;
  offsetTop: number;
}

export interface ScrollRow {
  index: number;
  start: number;
  size: number;
}

interface SessionViewState {
  scroll?: ScrollAnchor;
  draft?: string;
}

export const MAX_VIEW_STATE_SESSIONS = 200;

const states = new Map<string, SessionViewState>();

function entryForWrite(uiSid: string): SessionViewState {
  const current = states.get(uiSid);
  if (current) return current;
  const next: SessionViewState = {};
  states.set(uiSid, next);
  while (states.size > MAX_VIEW_STATE_SESSIONS) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
  return next;
}

function dropEntryIfEmpty(uiSid: string, entry: SessionViewState): void {
  if (entry.scroll || entry.draft !== undefined) return;
  states.delete(uiSid);
}

export function saveScroll(uiSid: string, anchor: ScrollAnchor): void {
  const entry = entryForWrite(uiSid);
  entry.scroll = { messageId: anchor.messageId, offsetTop: anchor.offsetTop };
}

export function loadScroll(uiSid: string): ScrollAnchor | null {
  const anchor = states.get(uiSid)?.scroll;
  return anchor ? { messageId: anchor.messageId, offsetTop: anchor.offsetTop } : null;
}

export function clearScroll(uiSid: string): void {
  const entry = states.get(uiSid);
  if (!entry) return;
  delete entry.scroll;
  dropEntryIfEmpty(uiSid, entry);
}

export function saveDraft(uiSid: string, text: string): void {
  const entry = entryForWrite(uiSid);
  entry.draft = text;
}

export function loadDraft(uiSid: string): string {
  return states.get(uiSid)?.draft ?? "";
}

export function clearDraft(uiSid: string): void {
  const entry = states.get(uiSid);
  if (!entry) return;
  delete entry.draft;
  dropEntryIfEmpty(uiSid, entry);
}

export function forget(uiSid: string): void {
  states.delete(uiSid);
}

export function topVisibleRow<T extends ScrollRow>(
  rows: readonly T[],
  scrollTop: number,
): T | null {
  for (const row of rows) {
    if (row.start + row.size <= scrollTop) continue;
    return row;
  }
  return null;
}

export function restoreAnchorScrollTop(
  anchor: ScrollAnchor,
  scrollTop: number,
  currentOffset: number,
): number {
  return anchorTargetScrollTop(scrollTop, currentOffset, anchor.offsetTop);
}

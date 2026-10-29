export type NoticeSeverity = "info" | "warning" | "error";

export type UiNotice = {
  id: string;
  severity: NoticeSeverity;
  title: string;
  description?: string;
  count: number;
  at: number;
};

export type NoticeInput = Omit<UiNotice, "id" | "count" | "at">;

export const NOTICE_LIMIT = 5;

/** Unknown severities are informational, never silently elevated. */
export function asNoticeSeverity(value: unknown): NoticeSeverity {
  return value === "warning" || value === "error" ? value : "info";
}

function sameNotice(a: Pick<UiNotice, "title" | "description">, b: NoticeInput): boolean {
  return a.title === b.title && a.description === b.description;
}

function noticeId(next: NoticeInput & { at: number }): string {
  return `notice:${next.at}:${next.severity}:${next.title}:${next.description ?? ""}`;
}

/**
 * Append a live notice, folding identical title+description pairs into one row.
 * Notices are oldest-first; the UI renders them in that order.
 */
export function pushNotice(
  list: UiNotice[],
  next: NoticeInput & { at: number },
): UiNotice[] {
  const severity = asNoticeSeverity(next.severity);
  const normalized = { ...next, severity };
  const index = list.findIndex((entry) => sameNotice(entry, normalized));
  if (index >= 0) {
    return list.map((entry, i) =>
      i === index ? { ...entry, count: entry.count + 1 } : entry,
    );
  }
  return [
    ...list,
    {
      ...normalized,
      id: noticeId(normalized),
      count: 1,
    },
  ].slice(-NOTICE_LIMIT);
}

export function dismissNotice(list: UiNotice[], id: string): UiNotice[] {
  return list.filter((entry) => entry.id !== id);
}

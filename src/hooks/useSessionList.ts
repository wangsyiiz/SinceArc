import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { sessionsList, type SessionRowDto } from "@/lib/ipc";
import type { SessionSummary } from "@/types";

// SessionSummary["group"] 是 types.ts 里的领域值，侧栏按这些稳定值分组并在渲染时翻译。
const GROUP_LABELS: Record<string, SessionSummary["group"]> = {
  today: "今天", // i18n-ignore: SessionSummary.group domain value
  yesterday: "昨天", // i18n-ignore: SessionSummary.group domain value
  earlier: "更早", // i18n-ignore: SessionSummary.group domain value
};

export function useSessionList(): {
  sessions: SessionSummary[];
  setSessions: Dispatch<SetStateAction<SessionSummary[]>>;
  /** 重新读库：首条消息落地后标题会变（后端按第一条用户消息命名） */
  reload: () => Promise<SessionSummary[] | null>;
} {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  /** 库行 -> 侧栏条目；分组与显示时间都由后端按本地时区算好 */
  const toSummary = (r: SessionRowDto): SessionSummary => {
    return {
      id: r.id,
      title: r.title,
      cwd: r.cwd,
      updatedAt: r.displayTime ?? "",
      updatedAtSec: r.updatedAt,
      group: GROUP_LABELS[r.dayBucket ?? ""] ?? "更早", // i18n-ignore: SessionSummary.group domain value
      playerIds: [],
      acpSessionId: r.acpSessionId ?? null,
      profileId: r.profileId ?? undefined,
      unreadCount: r.unreadCount ?? 0,
    };
  };

  const reload = useCallback(async () => {
    try {
      const rows = await sessionsList();
      const next = rows.map(toSummary);
      setSessions(next);
      return next;
    } catch {
      // 非 Tauri 环境：保持现状
      return null;
    }
  }, []);

  // 库里的会话列表：启动读一次，之后每次变更都回写
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await sessionsList();
        if (alive) setSessions(rows.map(toSummary));
      } catch {
        // 非 Tauri 环境：保持空列表
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { sessions, setSessions, reload };
}

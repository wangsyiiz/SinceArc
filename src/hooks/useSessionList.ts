import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { sessionsList, type SessionRowDto } from "@/lib/ipc";
import type { SessionSummary } from "@/types";

const GROUP_LABELS: Record<string, SessionSummary["group"]> = {
  today: "今天",
  yesterday: "昨天",
  earlier: "更早",
};

export function useSessionList(): {
  sessions: SessionSummary[];
  setSessions: Dispatch<SetStateAction<SessionSummary[]>>;
  /** 重新读库：首条消息落地后标题会变（后端按第一条用户消息命名） */
  reload: () => Promise<void>;
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
      group: GROUP_LABELS[r.dayBucket ?? ""] ?? "更早",
      playerIds: [],
      acpSessionId: r.acpSessionId ?? null,
      profileId: r.profileId ?? undefined,
    };
  };

  const reload = useCallback(async () => {
    try {
      const rows = await sessionsList();
      setSessions(rows.map(toSummary));
    } catch {
      // 非 Tauri 环境：保持现状
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

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { sessionsList, type SessionRowDto } from "@/lib/ipc";
import type { SessionSummary } from "@/types";

export function useSessionList(): {
  sessions: SessionSummary[];
  setSessions: Dispatch<SetStateAction<SessionSummary[]>>;
  /** 重新读库：首条消息落地后标题会变（后端按第一条用户消息命名） */
  reload: () => Promise<void>;
} {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  /** 库行 -> 侧栏条目（时间与分组都按库里的时间戳算） */
  const toSummary = (r: SessionRowDto): SessionSummary => {
    const at = new Date(r.updatedAt * 1000);
    const today = new Date();
    const sameDay = at.toDateString() === today.toDateString();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    return {
      id: r.id,
      title: r.title,
      cwd: r.cwd,
      updatedAt: sameDay
        ? at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
        : at.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }),
      updatedAtSec: r.updatedAt,
      group: sameDay ? "今天" : at.toDateString() === yesterday.toDateString() ? "昨天" : "更早",
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

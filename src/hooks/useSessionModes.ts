import { useCallback, useState } from "react";
import {
  asCmdError,
  sessionApplyMode,
  sessionChooseMode,
  type ModeOption,
  type ModesSnapshot,
} from "@/lib/ipc";

export interface ModeView {
  available: ModeOption[];
  /** agent 当前生效值；agent 自己改也会更新它 */
  current: string | null;
  /** 我们推上去并成功的那个（null = 没推） */
  applied: string | null;
  following: boolean;
  warning: string | null;
}

function emptyView(): ModeView {
  return { available: [], current: null, applied: null, following: true, warning: null };
}

export function useSessionModes(): {
  /** 按 UI 会话 id 索引 */
  bySid: Record<string, ModeView>;
  /** 按连接索引最近一次见到的模式快照（设置页的水位来源：可选列表 + agent 当前值） */
  byProfile: Record<string, ModesSnapshot>;
  /** 打开/恢复会话之后调：先记下可选模式，再让后端按 override ?? default 推值 */
  applyFor: (args: {
    profileId: string;
    acpSessionId: string;
    uiSessionId: string;
    snapshot: ModesSnapshot | null;
  }) => Promise<void>;
  /** 用户在选择器里选；null = 改回跟随连接默认 */
  choose: (args: {
    profileId: string;
    acpSessionId: string;
    uiSessionId: string;
    modeId: string | null;
  }) => Promise<void>;
  /** agent 自己发了 current_mode_update：只更新显示，绝不写存储（规范 §5 最后一行） */
  noteAgentSwitch: (uiSessionId: string, modeId: string) => void;
} {
  const [bySid, setBySid] = useState<Record<string, ModeView>>({});
  const [byProfile, setByProfile] = useState<Record<string, ModesSnapshot>>({});

  const applyFor = useCallback(
    async ({
      profileId,
      acpSessionId,
      uiSessionId,
      snapshot,
    }: {
      profileId: string;
      acpSessionId: string;
      uiSessionId: string;
      snapshot: ModesSnapshot | null;
    }) => {
      if (snapshot !== null) {
        setByProfile((prev) => ({ ...prev, [profileId]: snapshot }));
        setBySid((prev) => {
          const old = prev[uiSessionId] ?? emptyView();
          return {
            ...prev,
            [uiSessionId]: {
              ...old,
              available: snapshot.available,
              // agent 报的当前值优先；它没给才保留旧的
              current: snapshot.current || old.current,
            },
          };
        });
      }

      try {
        const out = await sessionApplyMode(profileId, acpSessionId, uiSessionId);
        setBySid((prev) => {
          const old = prev[uiSessionId] ?? emptyView();
          return {
            ...prev,
            [uiSessionId]: {
              ...old,
              // 没推成时 applied 为 null，不能把 agent 报的当前值一并抹掉
              current: out.applied ?? old.current,
              applied: out.applied,
              following: out.following,
              warning: out.warning ?? null,
            },
          };
        });
      } catch (e) {
        const err = asCmdError(e);
        setBySid((prev) => {
          const old = prev[uiSessionId] ?? emptyView();
          return {
            ...prev,
            [uiSessionId]: { ...old, warning: `${err.code} ${err.msg}` },
          };
        });
      }
    },
    [],
  );

  const choose = useCallback(
    async ({
      profileId,
      acpSessionId,
      uiSessionId,
      modeId,
    }: {
      profileId: string;
      acpSessionId: string;
      uiSessionId: string;
      modeId: string | null;
    }) => {
      try {
        const out = await sessionChooseMode(profileId, acpSessionId, uiSessionId, modeId);
        setBySid((prev) => {
          const old = prev[uiSessionId] ?? emptyView();
          return {
            ...prev,
            [uiSessionId]: {
              ...old,
              current: out.applied ?? old.current,
              applied: out.applied,
              following: out.following,
              warning: out.warning ?? null,
            },
          };
        });
      } catch (e) {
        const err = asCmdError(e);
        setBySid((prev) => {
          const old = prev[uiSessionId] ?? emptyView();
          // 后端失败时不会改库，界面也不能假装 applied/following 已经变了
          return {
            ...prev,
            [uiSessionId]: { ...old, warning: `${err.code} ${err.msg}` },
          };
        });
      }
    },
    [],
  );

  const noteAgentSwitch = useCallback((uiSessionId: string, modeId: string) => {
    setBySid((prev) => {
      const old = prev[uiSessionId] ?? emptyView();
      return { ...prev, [uiSessionId]: { ...old, current: modeId } };
    });
  }, []);

  return { bySid, byProfile, applyFor, choose, noteAgentSwitch };
}

import { useCallback, useEffect, useRef } from "react";
import {
  asCmdError,
  connectAgent,
  disconnectAgent,
  type AcpEvent,
  type CmdError,
  type ModesSnapshot,
} from "@/lib/ipc";
import type { AgentProfile } from "@/types";

export interface EnsureResult {
  /** 已有或新建的 ACP 会话 id；null = 没连上 */
  acpSid: string | null;
  error: CmdError | null;
}

interface Deps {
  profiles: AgentProfile[];
  /** 已有的 profile → ACP 会话映射，用来判断「还用不用连」 */
  sessionsByProfile: Record<string, string>;
  onUpdateProfile: (p: AgentProfile) => void;
  onAgentEvent: (profileId: string, event: AcpEvent) => void;
  onSession: (profileId: string, acpSessionId: string, snapshot: ModesSnapshot | null) => void;
}

/**
 * 连接生命周期：把「谁去连、连几次、连不上怎么报」收在一处。
 *
 * 自动启动（打开会话就连）和设置页手动连接都会走这里 —— 两处各写一份的话，
 * 迟早出现同一 profile 被并发 connect 两次（后端会把刚起来的进程 kill 掉）。
 */
export function useAgentConnect({
  profiles,
  sessionsByProfile,
  onUpdateProfile,
  onAgentEvent,
  onSession,
}: Deps) {
  /** 同一 profile 在飞的连接；后到的调用复用它，不重新发命令 */
  const inflight = useRef(new Map<string, Promise<EnsureResult>>());
  // 回调与快照用 ref 兜住：ensureConnected 会在事件回调里被调，不能依赖渲染闭包
  const stateRef = useRef({ profiles, sessionsByProfile, onUpdateProfile, onAgentEvent, onSession });
  useEffect(() => {
    stateRef.current = { profiles, sessionsByProfile, onUpdateProfile, onAgentEvent, onSession };
  }, [profiles, sessionsByProfile, onUpdateProfile, onAgentEvent, onSession]);

  /** 显式连接（设置页按钮）。失败抛 CmdError，由调用方决定怎么显示。 */
  const connect = useCallback(async (p: AgentProfile): Promise<string> => {
    const s = stateRef.current;
    const out = await connectAgent(p, (e) => s.onAgentEvent(p.id, e));
    s.onUpdateProfile({
      ...p,
      connected: true,
      agentName: `${out.agentName} ${out.agentVersion}`,
      protocolVersion: out.protocolVersion,
    });
    if (!out.sessionId) {
      // 握上手但没会话：后端认为连上了，实际没法发消息，必须当失败处理
      throw new Error("agent 没有给出会话");
    }
    s.onSession(p.id, out.sessionId, out.modes ?? null);
    return out.sessionId;
  }, []);

  /**
   * 没有就连接（无感启动）。永不抛异常：失败以 `error` 返回，调用方写进会话消息流，
   * 因为这条路径是用户点开会话顺手触发的，用模态框打断他不对。
   */
  const ensureConnected = useCallback(
    (profileId: string | null | undefined): Promise<EnsureResult> => {
      if (!profileId) return Promise.resolve({ acpSid: null, error: null });

      // 已经有 ACP 会话：直接复用，不重连
      const existing = stateRef.current.sessionsByProfile[profileId];
      if (existing) return Promise.resolve({ acpSid: existing, error: null });

      const pending = inflight.current.get(profileId);
      if (pending) return pending;

      const profile = stateRef.current.profiles.find((p) => p.id === profileId);
      if (!profile) {
        return Promise.resolve({
          acpSid: null,
          error: { code: 50100, msg: "这个会话没有可用的连接配置" },
        });
      }

      const task = connect(profile)
        .then((acpSid) => ({ acpSid, error: null }))
        .catch((e): EnsureResult => ({ acpSid: null, error: asCmdError(e) }))
        .finally(() => {
          inflight.current.delete(profileId);
        });

      inflight.current.set(profileId, task);
      return task;
    },
    [connect],
  );

  const disconnect = useCallback(async (profileId: string): Promise<void> => {
    await disconnectAgent(profileId);
    const s = stateRef.current;
    const profile = s.profiles.find((p) => p.id === profileId);
    if (profile) {
      s.onUpdateProfile({ ...profile, connected: false, agentName: null, protocolVersion: null });
    }
  }, []);

  return { connect, ensureConnected, disconnect };
}

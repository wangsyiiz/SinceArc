import { useCallback, useEffect, useRef } from "react";
import {
  asCmdError,
  connectAgent,
  disconnectAgent,
  onAgentEvent as onAgentEvent_,
  type AcpEvent,
  type CmdError,
  type ModesSnapshot,
  type ResumeOutcome,
} from "@/lib/ipc";
import type { AgentProfile } from "@/types";

export interface EnsureResult {
  /** 已有或新建的 ACP 会话 id；null = 没连上 */
  acpSid: string | null;
  error: CmdError | null;
  /** 这次连接的恢复判定；复用已有映射时为 null（没有重新判定） */
  resume: ResumeOutcome | null;
  /** 续上前的本地事件水位 */
  lastEventSeq: number | null;
}

export interface ConnectResult {
  acpSid: string | null;
  resume: ResumeOutcome;
  lastEventSeq: number | null;
}

interface Deps {
  profiles: AgentProfile[];
  /** 已有的 profile → ACP 会话映射，用来判断「还用不用连」 */
  sessionsByProfile: Record<string, string>;
  onUpdateProfile: (p: AgentProfile) => void;
  onAgentEvent: (profileId: string, event: AcpEvent, topic: string) => void;
  onSession: (
    profileId: string,
    acpSessionId: string,
    snapshot: ModesSnapshot | null,
    uiSid?: string,
  ) => void;
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
  const connect = useCallback(async (p: AgentProfile, uiSid?: string): Promise<ConnectResult> => {
    const s = stateRef.current;
    // 先登记处理器、再连接：单通道按 profileId 分发，事件不会因为「还没订阅」而丢
    await onAgentEvent_(p.id, (e, topic) => s.onAgentEvent(p.id, e, topic));
    const out = await connectAgent(p, uiSid);
    s.onUpdateProfile({
      ...p,
      connected: true,
      agentName: `${out.agentName} ${out.agentVersion}`,
      protocolVersion: out.protocolVersion,
      // 能力来自这次握手：换了 agent 或升级了版本，这里的值会跟着变
      caps: out.caps,
      capsAt: Math.floor(Date.now() / 1000),
    });
    if (!out.sessionId && out.resume.kind !== "unavailable") {
      // 握上手但没会话：后端认为连上了，实际没法发消息，必须当失败处理。
      // Unavailable 是显式结果，由调用方展示「续不上」，不能混成通用连接失败。
      throw new Error("agent 没有给出会话");
    }
    if (out.sessionId) {
      s.onSession(p.id, out.sessionId, out.modes ?? null, uiSid);
    }
    return {
      acpSid: out.sessionId ?? null,
      resume: out.resume,
      lastEventSeq: out.lastEventSeq ?? null,
    };
  }, []);

  /**
   * 没有就连接（无感启动）。永不抛异常：失败以 `error` 返回，调用方写进会话消息流，
   * 因为这条路径是用户点开会话顺手触发的，用模态框打断他不对。
   */
  const disconnect = useCallback(async (profileId: string): Promise<void> => {
    await disconnectAgent(profileId);
    const s = stateRef.current;
    const profile = s.profiles.find((p) => p.id === profileId);
    if (profile) {
      s.onUpdateProfile({ ...profile, connected: false, agentName: null, protocolVersion: null });
    }
  }, []);

  const ensureConnected = useCallback(
    async (
      profileId: string | null | undefined,
      uiSid?: string,
      opts?: { force?: boolean },
    ): Promise<EnsureResult> => {
      if (!profileId) {
        return Promise.resolve({
          acpSid: null,
          error: null,
          resume: null,
          lastEventSeq: null,
        });
      }

      // 已经有 ACP 会话：直接复用，不重连。
      // force = 用户点「重试」：必须真的重来一次（断开 → 重连），否则复用会让重试看起来毫无反应 ——
      // 尤其是「续不上」那种：握手是通的，复用就直接返回，判定根本不会重跑。
      const existing = stateRef.current.sessionsByProfile[profileId];
      if (existing && opts?.force) {
        await disconnect(profileId);
        // 等映射真的被清掉（conn.exited 是事件，不是 disconnect 的返回值）：
        // 不等就 reconnect，后端会回「已连接」，界面反而显示一条假的失败
        for (let i = 0; i < 30 && stateRef.current.sessionsByProfile[profileId]; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } else if (existing) {
        return Promise.resolve({
          acpSid: existing,
          error: null,
          resume: null,
          lastEventSeq: null,
        });
      }

      const pending = inflight.current.get(profileId);
      if (pending) return pending;

      const profile = stateRef.current.profiles.find((p) => p.id === profileId);
      if (!profile) {
        return Promise.resolve({
          acpSid: null,
          error: { code: 50100, msg: "这个会话没有可用的连接配置" },
          resume: null,
          lastEventSeq: null,
        });
      }

      const task = connect(profile, uiSid)
        .then((r) => ({
          acpSid: r.acpSid,
          error: null,
          resume: r.resume,
          lastEventSeq: r.lastEventSeq,
        }))
        .catch((e): EnsureResult => ({
          acpSid: null,
          error: asCmdError(e),
          resume: null,
          lastEventSeq: null,
        }))
        .finally(() => {
          inflight.current.delete(profileId);
        });

      inflight.current.set(profileId, task);
      return task;
    },
    [connect, disconnect],
  );

  return { connect, ensureConnected, disconnect };
}

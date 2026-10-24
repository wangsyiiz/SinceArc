// 与 Rust 对应的 IPC 类型由 `cargo test --lib export_bindings` 生成到 ./types.gen/。
// 手写副本已删除；这里只保留 Rust 侧没有对应 struct、或定义在生成范围之外的类型。

import type { Message } from "@/types";

export type {
  AcpEvent,
  AgentCaps,
  WireEvent,
  AgentUserRow as AgentUser,
  AgentUserTestOutcome as AgentUserTestResult,
  BindingRow,
  ConnectOutcome,
  DelegateHandleDto,
  DelegateOutcomeDto,
  MessageRow as MessageRowDto,
  ModeChoice,
  ModeOption,
  ProbeOutcome,
  ProfileDto,
  PruneReport,
  ResumeOutcome,
  SessionInfo,
  SessionLoadOutcome,
  SessionModes as ModesSnapshot,
  SessionRow as SessionRowDto,
  SessionUpsert,
  TraceItem as TraceItemDto,
  TraceTurn as TraceTurnDto,
  TurnRow,
} from "./types.gen";


export interface EventRoute {
  /** ACP 会话 id */
  sessionId?: string | null;
  /** 该投给哪个界面会话 */
  uiSessionId?: string | null;
  /** 发言者：群成员 id；主 agent 时为 null */
  authorId?: string | null;
}

export type RespondOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** 权限应答的本地轨迹元数据；不进入 ACP 协议。 */
export interface PermissionDecision {
  /** 裁定：allow = 放行（含 always），reject = 拒绝/取消。写进轨迹，界面不再靠猜。 */
  verdict: "allow" | "reject";
  optionId: string | null;
  optionLabel: string | null;
  actorMemberId: string | null;
  note: string | null;
  /** E13.6b 会使用 auto:edits；本项只有 user。 */
  via: "user" | "auto:edits";
}

// 候选/命中/扫描结果的 Rust 名与前端旧名不同，这里做映射。
export type { Candidate as DiscoveryCandidate, Found as DiscoveryHit, DiscoverOutcome as DiscoveryOutcome } from "./types.gen";

export interface SessionUpdate {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    currentModeId?: string;
    content?: { type?: string; text?: string };
    [k: string]: unknown;
  };
}

/**
 * 历史行的 payload 就是前端 `Message` 的形状。派活发起行额外带 `delegate`，
 * 这里只做一次结构校验：读不到或形状不对就原样当普通用户消息，不能让一条坏记录消失。
 */
export function messageFromPayload(payload: unknown): Message {
  if (!payload || typeof payload !== "object") return payload as Message;
  const raw = payload as Record<string, unknown>;
  if (raw.role !== "user" || !raw.delegate || typeof raw.delegate !== "object") {
    return payload as Message;
  }

  const delegate = raw.delegate as Record<string, unknown>;
  const context = delegate.context;
  const delegateContext =
    context === "inherited" || context === "task_only" ? context : null;
  const handleId = typeof delegate.handleId === "string" ? delegate.handleId : "";
  if (
    typeof delegate.targetMemberId !== "string" ||
    typeof delegate.targetName !== "string" ||
    delegateContext === null ||
    typeof delegate.reason !== "string"
  ) {
    return payload as Message;
  }

  return {
    ...(raw as Extract<Message, { role: "user" }>),
    delegate: {
      handleId,
      targetMemberId: delegate.targetMemberId,
      targetName: delegate.targetName,
      context: delegateContext,
      reason: delegate.reason,
    },
  };
}


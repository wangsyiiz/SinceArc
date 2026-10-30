// 与 Rust 对应的 IPC 类型由 `cargo test --lib export_bindings` 生成到 ./types.gen/。
// 手写副本已删除；这里只保留 Rust 侧没有对应 struct、或定义在生成范围之外的类型。

import type { Message } from "@/types";
import type { MessageRow } from "./types.gen/MessageRow";

export type {
  AcpEvent,
  AgentCaps,
  WireEvent,
  AgentUserRow as AgentUser,
  AgentUserTestOutcome as AgentUserTestResult,
  BindingRow,
  CommandDto,
  ConnectOutcome,
  DelegateHandleDto,
  DelegateOutcomeDto,
  DiffPageDto,
  FileDto,
  GhRepoListDto,
  GhRepoListingDto,
  GhStatusDto,
  LocalRepoDto,
  MessageRow as MessageRowDto,
  MessageInput,
  McpCatalogEntryDto,
  McpKeyValueDto,
  McpServerDto,
  ModeChoice,
  ModeOption,
  ProbeOutcome,
  ProfileDto,
  PrDetailDto,
  PrDto,
  PrListDto,
  PrStateView,
  CheckState,
  RepoDto,
  RepoListDto,
  RepoRefDto,
  ResumeOutcome,
  SessionInfo,
  SessionLoadOutcome,
  SessionMcpStateDto,
  SessionModes as ModesSnapshot,
  SessionPromptResult,
  SessionRow as SessionRowDto,
  SessionUpsert,
  TraceItem as TraceItemDto,
  TraceTurn as TraceTurnDto,
  TurnRow,
  ViewerDto,
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
    messageId?: string;
    content?: { type?: string; text?: string };
    [k: string]: unknown;
  };
}

function withRowAttribution(
  message: Message,
  turnId: string | null | undefined,
  atomKind: string,
): Message {
  return {
    ...message,
    atomKind,
    ...(turnId === undefined ? {} : { turnId }),
  };
}

/**
 * 历史行的 payload 就是前端 `Message` 的形状。派活发起行额外带 `delegate`，
 * 这里只做一次结构校验：读不到或形状不对就原样当普通用户消息，不能让一条坏记录消失。
 *
 * `turnId` 是 `messages.turn_id` 的权威值；payload 里的同名字段只在直接调用、
 * 没有行上下文时兜底。历史读取必须走 `messageFromRow`，避免只有正文、没有轮归属。
 */
export function messageFromPayload(
  payload: unknown,
  turnId: string | null | undefined,
  atomKind: string,
): Message {
  if (!payload || typeof payload !== "object") return payload as Message;
  const raw = payload as Record<string, unknown>;
  const payloadTurnId =
    typeof raw.turnId === "string" || raw.turnId === null
      ? raw.turnId
      : undefined;
  const resolvedTurnId = turnId === undefined ? payloadTurnId : turnId;
  if (raw.role !== "user" || !raw.delegate || typeof raw.delegate !== "object") {
    return withRowAttribution(payload as Message, resolvedTurnId, atomKind);
  }

  const delegate = raw.delegate as Record<string, unknown>;
  const context = delegate.context;
  const delegateContext =
    context === "member_fork" || context === "task_only" ? context : null;
  const handleId = typeof delegate.handleId === "string" ? delegate.handleId : "";
  if (
    typeof delegate.targetMemberId !== "string" ||
    typeof delegate.targetName !== "string" ||
    delegateContext === null ||
    typeof delegate.reason !== "string"
  ) {
    return withRowAttribution(payload as Message, resolvedTurnId, atomKind);
  }

  return withRowAttribution(
    {
      ...(raw as unknown as Extract<Message, { role: "user" }>),
      delegate: {
        handleId,
        targetMemberId: delegate.targetMemberId,
        targetName: delegate.targetName,
        context: delegateContext,
        reason: delegate.reason,
      },
    },
    resolvedTurnId,
    atomKind,
  );
}

/** `MessageRow` → `Message`：轮归属只认行上的 `turn_id`。 */
export function messageFromRow(row: MessageRow): Message {
  return messageFromPayload(row.payload, row.turnId, row.atomKind);
}


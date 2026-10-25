import { useState } from "react";
import {
  CircleDot,
  FileText,
  GitPullRequest,
  SendHorizontal,
  Square,
  Waypoints,
} from "lucide-react";
import type { Message, Player, QuotedRef } from "@/types";
import { cn } from "@/lib/utils";
import { delegateActionLabel } from "@/lib/delegate-status";
import { delegateCapsDetail } from "@/lib/delegate-target";
import { chatVisibilityOf } from "@/lib/chat-visibility";
import { normaliseTurnId } from "@/lib/turn-align";
import { PlayerAvatar } from "./PlayerAvatar";
import { RemovedBadge } from "./RemovedBadge";

/**
 * 把 @handle 渲染成该玩家的颜色。
 *
 * 不用 `/@([a-zA-Z][\w-]*)/`：短名可能有中文（`hermes-测试2`），字符集正则会把
 * `@hermes-测` 截断，高亮只剩一半。改成按**已知短名**拼 alternation，长的排在前面
 * （否则 `@hermes-测试2` 会被 `@hermes-测试` 抢先匹配）。
 */
function renderText(text: string, players: Player[]) {
  const handles = players
    .map((p) => p.handle)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (handles.length === 0) return <span>{text}</span>;
  const escaped = handles.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(@(?:${escaped.join("|")}))`, "gi");
  return text.split(re).map((part, i) => {
    if (i % 2 === 1) {
      const handle = part.slice(1).toLowerCase();
      const p = players.find((pl) => pl.handle.toLowerCase() === handle);
      if (p) {
        return (
          <span key={i} style={{ color: p.color }} className="font-medium">
            {part}
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
}

function QuoteBlock({ quoted }: { quoted: QuotedRef }) {
  const Icon = quoted.kind === "pr" ? GitPullRequest : quoted.kind === "issue" ? CircleDot : FileText;
  return (
    <div className="flex items-start gap-2 rounded-control border border-line-1/70 bg-surface-2/50 px-2.5 py-1.5">
      <Icon className="mt-0.5 size-3 shrink-0 text-ink-3" />
      <div className="min-w-0">
        <div className="truncate text-caption text-ink-2">{quoted.label}</div>
        {quoted.detail && (
          <div className="truncate font-mono text-micro text-ink-3">{quoted.detail}</div>
        )}
      </div>
    </div>
  );
}

export function MessageItem({
  message,
  players,
  delegatePhase,
  onCancelDelegate,
  onLocateTrace,
}: {
  message: Message;
  players: Player[];
  delegatePhase?: string | null;
  onCancelDelegate?: (handleId: string) => void | Promise<void>;
  onLocateTrace?: (turnId: string) => void;
}) {
  const [delegateExpanded, setDelegateExpanded] = useState(false);

  const chatKind = chatVisibilityOf(message);
  if (chatKind === null) return null;

  if (chatKind === "notice.system") {
    return (
      <div className="flex justify-center py-0.5">
        <span className="rounded-full bg-surface-3/35 px-2.5 py-1 font-mono text-micro text-ink-3">
          {message.text}
        </span>
      </div>
    );
  }

  if (chatKind === "aside" && message.role === "user") {
    return (
      <div className="flex flex-col gap-0.5 text-caption text-ink-3">
        <div className="whitespace-pre-wrap">{renderText(message.text, players)}</div>
        {message.asideReceipt && (
          <div className="whitespace-pre-wrap">{message.asideReceipt}</div>
        )}
      </div>
    );
  }

  if (chatKind === "delegate.card" && message.role === "user") {
    if (message.delegate) {
      const handleId = message.delegate.handleId;
      const action = delegateActionLabel(delegatePhase);
      return (
        <div className="flex w-full flex-col gap-1 border-l-2 border-line-1/60 pl-2.5 text-left">
          <div className="flex items-center gap-1.5 text-micro text-ink-3">
            <SendHorizontal size={12} className="shrink-0" />
            <button
              type="button"
              aria-expanded={delegateExpanded}
              onClick={() => setDelegateExpanded((expanded) => !expanded)}
              className="min-w-0 flex-1 truncate text-left"
            >
              派活给 {message.delegate.targetName} ·{" "}
              {delegateCapsDetail(message.delegate.context, message.delegate.reason)}
            </button>
            {action === "停止" ? (
              <button
                type="button"
                aria-label="停止这次派活"
                onClick={() => void onCancelDelegate?.(handleId)}
                className="flex shrink-0 items-center gap-1 text-caption text-ink-3 hover:text-ink-1"
              >
                <Square size={12} />
                停止
              </button>
            ) : action ? (
              <span className="shrink-0 text-caption text-ink-3">{action}</span>
            ) : null}
          </div>
          <button
            type="button"
            aria-expanded={delegateExpanded}
            onClick={() => setDelegateExpanded((expanded) => !expanded)}
            title={message.text}
            className={cn(
              // 展开只改「看不看得全」，不改字号 —— 点一下字变大，会像整块内容在跳。
              "text-left text-small text-ink-2",
              delegateExpanded ? "whitespace-pre-wrap" : "truncate",
            )}
          >
            {renderText(message.text, players)}
          </button>
        </div>
      );
    }
    return null;
  }

  if (chatKind === "text.user" && message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.quoted && <div className="max-w-3/4"><QuoteBlock quoted={message.quoted} /></div>}
        <div className="max-w-3/4 rounded-card rounded-br-mark bg-surface-2 px-3.5 py-2.5 text-ui leading-relaxed whitespace-pre-wrap text-ink-1">
          {renderText(message.text, players)}
        </div>
      </div>
    );
  }

  if (chatKind !== "text.agent" || message.role !== "player") return null;

  const p = players.find((x) => x.id === message.playerId);
  const traceTurnId = normaliseTurnId(message.turnId);
  return (
    <div className="flex gap-2.5">
      {p && <PlayerAvatar player={p} size={22} className="mt-0.5" />}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className="text-caption font-medium" style={{ color: p?.color }}>
            {p?.name ?? "agent"}
          </span>
          <RemovedBadge player={p} />
          <span className="font-mono text-micro text-ink-3">{message.at}</span>
          {traceTurnId && onLocateTrace && (
            <button
              type="button"
              aria-label="在轨迹里看这一轮"
              onClick={() => onLocateTrace(traceTurnId)}
              className="inline-flex shrink-0 self-center items-center text-ink-3 transition-colors hover:text-ink-1"
            >
              <Waypoints className="size-3" />
            </button>
          )}
        </div>
        <div
          className={cn(
            "sc-prose whitespace-pre-wrap text-ui text-ink-1",
            message.streaming && "sc-caret",
          )}
        >
          {renderText(message.text, players)}
        </div>
        {/* 中途停下要留痕：否则用户只看到「回答没了后半段」，不知道是停了还是断了 */}
        {message.stopped && (
          <div className="mt-1 flex items-center gap-1.5 text-caption text-ink-3">
            <span className="inline-block size-1 rounded-full bg-ink-3" />
            已停止（这一轮没答完）
          </div>
        )}
      </div>
    </div>
  );
}

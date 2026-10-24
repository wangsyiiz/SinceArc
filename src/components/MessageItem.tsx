import { useState } from "react";
import { FileText, GitPullRequest, CircleDot, SendHorizontal } from "lucide-react";
import type { Message, Player, QuotedRef } from "@/types";
import { cn } from "@/lib/utils";
import { delegateCapsDetail } from "@/lib/delegate-target";
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

export function MessageItem({ message, players }: { message: Message; players: Player[] }) {
  const [delegateExpanded, setDelegateExpanded] = useState(false);

  if (message.role === "system") {
    return (
      <div className="flex justify-center py-0.5">
        <span className="rounded-full bg-surface-3/35 px-2.5 py-1 font-mono text-micro text-ink-3">
          {message.text}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    if (message.delegate) {
      return (
        <button
          type="button"
          aria-expanded={delegateExpanded}
          onClick={() => setDelegateExpanded((expanded) => !expanded)}
          className="flex w-full flex-col gap-1 border-l-2 border-line-1/60 pl-2.5 text-left"
        >
          <div className="flex items-center gap-1.5 text-micro text-ink-3">
            <SendHorizontal size={12} className="shrink-0" />
            <span className="min-w-0 truncate">
              派活给 {message.delegate.targetName} ·{" "}
              {delegateCapsDetail(message.delegate.context, message.delegate.reason)}
            </span>
          </div>
          <div
            title={message.text}
            className={cn(
              "text-ink-2",
              delegateExpanded ? "whitespace-pre-wrap text-ui" : "truncate text-small",
            )}
          >
            {renderText(message.text, players)}
          </div>
        </button>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.quoted && <div className="max-w-3/4"><QuoteBlock quoted={message.quoted} /></div>}
        <div className="max-w-3/4 rounded-card rounded-br-mark bg-surface-2 px-3.5 py-2.5 text-ui leading-relaxed whitespace-pre-wrap text-ink-1">
          {renderText(message.text, players)}
        </div>
      </div>
    );
  }

  const p = players.find((x) => x.id === message.playerId);
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

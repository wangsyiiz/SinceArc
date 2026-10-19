import { FileText, GitPullRequest, CircleDot } from "lucide-react";
import type { Message, Player, QuotedRef } from "@/types";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";

/** 把 @handle 渲染成该玩家的颜色 */
function renderText(text: string, players: Player[]) {
  return text.split(/(@[a-zA-Z][\w-]*)/g).map((part, i) => {
    const m = /^@([a-zA-Z][\w-]*)$/.exec(part);
    const p = m ? players.find((pl) => pl.handle === m[1]) : undefined;
    if (p) {
      return (
        <span key={i} style={{ color: p.color }} className="font-medium">
          @{p.handle}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function QuoteBlock({ quoted }: { quoted: QuotedRef }) {
  const Icon = quoted.kind === "pr" ? GitPullRequest : quoted.kind === "issue" ? CircleDot : FileText;
  return (
    <div className="flex items-start gap-2 rounded-[8px] border border-line-1/70 bg-white/[0.03] px-2.5 py-1.5">
      <Icon className="mt-[2px] size-3 shrink-0 text-ink-3" />
      <div className="min-w-0">
        <div className="truncate text-[11px] text-ink-2">{quoted.label}</div>
        {quoted.detail && (
          <div className="truncate font-mono text-[9.5px] text-ink-3">{quoted.detail}</div>
        )}
      </div>
    </div>
  );
}

export function MessageItem({ message, players }: { message: Message; players: Player[] }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center py-0.5">
        <span className="rounded-full bg-white/[0.04] px-2.5 py-1 font-mono text-[9.5px] text-ink-3">
          {message.text}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.quoted && <div className="max-w-[78%]"><QuoteBlock quoted={message.quoted} /></div>}
        <div className="max-w-[78%] rounded-[12px] rounded-br-[5px] bg-white/[0.055] px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-1">
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
          <span className="text-[11.5px] font-medium" style={{ color: p?.color }}>
            {p?.name ?? "agent"}
          </span>
          <span className="font-mono text-[9.5px] text-ink-3">{message.at}</span>
        </div>
        <div
          className={cn(
            "sc-prose whitespace-pre-wrap text-[13px] text-ink-1",
            message.streaming && "sc-caret",
          )}
        >
          {renderText(message.text, players)}
        </div>
      </div>
    </div>
  );
}

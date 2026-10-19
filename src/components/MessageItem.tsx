import { Sparkles } from "lucide-react";
import type { Message } from "@/types";
import { cn } from "@/lib/utils";
import { ToolCallCard } from "./ToolCallCard";

export function MessageItem({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-[14px] rounded-br-[5px] bg-surface-3 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-1">
          {message.text}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full border border-line-1 bg-surface-1 px-2.5 py-1 font-mono text-[10.5px] text-ink-3">
          {message.text}
        </span>
      </div>
    );
  }

  if (message.kind === "thinking") {
    return (
      <details className="group rounded-[10px] border border-line-1/70 bg-surface-1/40">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11.5px] text-ink-3">
          <Sparkles className="size-3" />
          思考
          <span className="ml-auto text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
            展开
          </span>
        </summary>
        <div className="border-t border-line-1/60 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
          {message.text}
        </div>
      </details>
    );
  }

  if (message.kind === "tool_call") {
    return <ToolCallCard call={message.call} />;
  }

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-line-1 bg-surface-2 text-accent-1">
        <span className="text-[11px] leading-none">◇</span>
      </div>
      <div
        className={cn(
          "sc-prose min-w-0 flex-1 whitespace-pre-wrap text-[13.5px] text-ink-1",
          message.streaming && "sc-caret",
        )}
      >
        {message.text}
      </div>
    </div>
  );
}

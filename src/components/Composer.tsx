import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Paperclip, AlertTriangle } from "lucide-react";
import type { Player } from "@/types";
import { cn } from "@/lib/utils";

interface ComposerProps {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
  players?: Player[];
  contextMessages?: number;
}

/** 粗估：系统提示 + 工具schema ≈ 1500 token，每条群聊记录 ≈ 45 token */
const estimateInput = (agents: number, ctx: number) => agents * (1500 + ctx * 45);

export function Composer({ busy, onSend, onStop, placeholder, players = [], contextMessages = 5 }: ComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !busy;
  const mentioned = players.filter((p) => value.includes(`@${p.handle}`));
  const parallelCost = mentioned.length > 2 ? estimateInput(mentioned.length, contextMessages) : 0;

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <>
      {parallelCost > 0 && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-[8px] border border-warn-1/20 bg-warn-1/[0.08] px-2.5 py-1 text-[10px] text-warn-1">
          <AlertTriangle className="size-3 shrink-0" />
          <span>
            {mentioned.length} 个玩家并行 · 每位约 {(estimateInput(1, contextMessages) / 1000).toFixed(1)}k
            输入 ≈ 合计 <span className="font-mono">{(parallelCost / 1000).toFixed(1)}k</span> token
            （含 {contextMessages} 条群聊上下文，粗估）
          </span>
        </div>
      )}
      <div
      className={cn(
        "sc-glass rounded-[12px] border-transparent transition-colors",
        busy && "border-accent-1/25",
      )}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        spellCheck={false}
        placeholder={placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            // 中文输入法组合期间不要发送
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            submit();
          }
        }}
        className="sc-selectable max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 pb-0.5 text-[13px] leading-relaxed text-ink-1 outline-none placeholder:text-ink-3"
      />
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button
          title="添加附件（未接线）"
          className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-2"
        >
          <Paperclip className="size-3.5" />
        </button>
        <span className="ml-0.5 font-mono text-[9.5px] text-ink-3">
          {busy ? "agent 正在输出" : "ACP · stdio"}
        </span>

        <div className="ml-auto">
          {busy ? (
            <button
              onClick={onStop}
              title="停止"
              className="grid size-7 place-items-center rounded-[8px] bg-surface-3/75 text-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] transition-colors hover:bg-surface-3"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              title="发送"
              className={cn(
                "grid size-7 place-items-center rounded-[8px] transition-all",
                canSend
                  ? "bg-accent-1 text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:brightness-110"
                  : "bg-surface-3/45 text-ink-3",
              )}
            >
              <ArrowUp className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

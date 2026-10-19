import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

interface ComposerProps {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
}

export function Composer({ busy, onSend, onStop, placeholder }: ComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <div
      className={cn(
        "sc-glass rounded-[14px] transition-colors",
        busy ? "border-accent-1/35" : "focus-within:border-line-2",
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
          className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink-2"
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
              className="grid size-7 place-items-center rounded-[8px] bg-white/[0.08] text-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] transition-colors hover:bg-white/[0.12]"
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
                  : "bg-white/[0.05] text-ink-3",
              )}
            >
              <ArrowUp className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

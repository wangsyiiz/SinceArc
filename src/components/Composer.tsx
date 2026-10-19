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
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <div className="px-4 pb-4">
      <div
        className={cn(
          "rounded-[16px] border bg-surface-1 transition-colors",
          busy ? "border-accent-1/40" : "border-line-1 focus-within:border-line-2",
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
          className="max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[13.5px] leading-relaxed text-ink-1 outline-none placeholder:text-ink-3"
        />
        <div className="flex items-center gap-1 px-2.5 pb-2">
          <button
            title="添加附件（未接线）"
            className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
          >
            <Paperclip className="size-4" />
          </button>
          <span className="ml-1 font-mono text-[10.5px] text-ink-3">
            {busy ? "agent 正在输出" : "ACP · stdio"}
          </span>

          <div className="ml-auto">
            {busy ? (
              <button
                onClick={onStop}
                title="停止"
                className="grid size-8 place-items-center rounded-lg border border-line-2 bg-surface-2 text-ink-1 transition-colors hover:bg-surface-3"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                title="发送"
                className={cn(
                  "grid size-8 place-items-center rounded-lg transition-all",
                  canSend
                    ? "bg-accent-1 text-accent-ink hover:brightness-110"
                    : "bg-surface-2 text-ink-3",
                )}
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 text-center font-mono text-[10px] text-ink-3">
        未接线版本 · 数据为本地演示
      </div>
    </div>
  );
}

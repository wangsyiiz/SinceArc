import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Paperclip } from "lucide-react";
import type { Player } from "@/types";
import type { AutoApproveLevel } from "@/lib/auto-approve";
import { cn } from "@/lib/utils";
import { Button } from "./ui/Button";

interface ComposerProps {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
  players?: Player[];
  autoApprove?: AutoApproveLevel;
  /** agent 档为 accept_edits / dont_ask：客户端这道闸被覆盖 */
  autoApproveCovered?: boolean;
  onToggleAutoApprove?: () => void;
}

export function Composer({
  busy,
  onSend,
  onStop,
  placeholder,
  players = [],
  autoApprove = "off",
  autoApproveCovered = false,
  onToggleAutoApprove,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  /**
   * @ 补全（docs/group-chat.md §3）：只列**本群成员**。
   * 候选来自 players（App 传进来的就是当前会话的成员），所以「没拉进群的人」不会出现在这里 ——
   * 与投递规则一致：能 @ 到的，就是能投到的。
   */
  const [mention, setMention] = useState<{ start: number; caret: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);

  const candidates = mention
    ? players.filter((p) => p.handle.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];

  /**
   * 从「光标前那一段」判断是不是正在敲 @handle。
   *
   * 不用字符集正则取 handle：短名可能有中文（如 `hermes-测试2`），`\w` 只认 ASCII，
   * 会把 `@hermes-测` 截成 `@hermes-`，候选看起来匹配、点下去却插错东西。
   * 这里只判断「@ 在哪、后面还是不是同一个词」，查询串按原样截取。
   */
  const syncMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const idx = before.lastIndexOf("@");
    if (idx < 0) {
      setMention(null);
      return;
    }
    // @ 必须在行首或空白之后：邮箱里的 @ 不该触发（john@example.com）
    if (idx > 0 && !/\s/.test(before[idx - 1])) {
      setMention(null);
      return;
    }
    const query = before.slice(idx + 1);
    // 中间出现空白 → 这个词已经敲完了，不再补全
    if (/\s/.test(query)) {
      setMention(null);
      return;
    }
    setMention({ start: idx, caret, query });
    setActive(0);
  };

  const pick = (handle: string) => {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}@${handle} ${value.slice(mention.caret)}`;
    setValue(next);
    setMention(null);
    // 光标落在插入内容之后
    const pos = mention.start + handle.length + 2;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !busy;

  const autoApproveText = autoApproveCovered
    ? "已被 agent 档覆盖"
    : autoApprove === "edits"
      ? "自动同意 · 编辑"
      : "自动同意：关";
  const autoApproveLabel = autoApproveCovered
    ? "自动同意已被 agent 审批档覆盖，当前不可切换"
    : autoApprove === "edits"
      ? "自动同意仅编辑类，已开启；点击关闭"
      : "自动同意已关闭；点击开启编辑类自动同意";

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
    setMention(null);
  };

  return (
    <>
      <div className="relative">
      {mention && (
        <div className="sc-glass absolute bottom-full left-2 z-30 mb-1.5 w-64 rounded-control p-1">
          {candidates.length > 0 ? (
            candidates.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => {
                  // 用 mousedown：click 之前 textarea 会先失焦，光标位置就丢了
                  e.preventDefault();
                  pick(p.handle);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-mark px-2 py-1 text-left transition-colors",
                  i === active ? "bg-surface-3/60" : "hover:bg-surface-3/45",
                )}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <span className="shrink-0 text-caption text-ink-1">{p.name}</span>
                <span className="shrink-0 font-mono text-micro text-ink-3">@{p.handle}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1 text-micro leading-relaxed text-ink-3">
              {players.length === 0
                ? "群里还没有成员 —— 点左栏的 + 把人拉进来，才能 @ 到"
                : `没有匹配 @${mention.query} 的成员`}
            </p>
          )}
        </div>
      )}
      <div
      className={cn(
        "sc-glass rounded-card transition-colors focus-within:border-accent-1",
        busy && "border-accent-1/25",
      )}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        spellCheck={false}
        placeholder={placeholder ?? "输入消息，Enter 发送，Shift+Enter 换行"}
        onChange={(e) => {
          setValue(e.target.value);
          syncMention(e.target.value, e.target.selectionStart ?? 0);
        }}
        onClick={(e) => syncMention(value, e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          // 补全列表开着的时候，方向键/回车/Tab 归它用
          if (mention && candidates.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (i + 1) % candidates.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i - 1 + candidates.length) % candidates.length);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pick(candidates[Math.min(active, candidates.length - 1)].handle);
              return;
            }
          }
          if (e.key === "Escape" && mention) {
            e.preventDefault();
            setMention(null);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            // 中文输入法组合期间不要发送
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            submit();
          }
        }}
        className="sc-selectable max-h-50 w-full resize-none bg-transparent px-3.5 pt-3 pb-0.5 text-ui leading-relaxed text-ink-1 focus-visible:outline-0 placeholder:text-ink-3"
      />
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <Button
          variant="ghost"
          size="sm"
          title="添加附件（未接线）"
          aria-label="添加附件（未接线）"
          className="size-7 gap-0 p-0"
        >
          <Paperclip className="size-3.5" />
        </Button>
        <span className="ml-0.5 font-mono text-micro text-ink-3">
          {busy ? "agent 正在输出" : "ACP · stdio"}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={autoApproveCovered}
            aria-label={autoApproveLabel}
            aria-pressed={!autoApproveCovered && autoApprove === "edits"}
            onClick={onToggleAutoApprove}
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-control border px-2 text-caption transition-colors",
              autoApproveCovered
                ? "cursor-not-allowed border-line-1 text-ink-3 opacity-45"
                : autoApprove === "edits"
                  ? "border-accent-1/50 bg-accent-1/10 text-accent-1 hover:bg-accent-1/15"
                  : "border-line-1 text-ink-2 hover:bg-surface-3/50",
            )}
          >
            {autoApproveText}
          </button>
          {busy ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onStop}
              title="停止"
              aria-label="停止"
              className="size-7 gap-0 bg-surface-3/75 p-0 hover:bg-surface-3"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              variant="glass"
              size="sm"
              onClick={submit}
              disabled={!canSend}
              disabledReason={!canSend ? "先输入内容再发送" : undefined}
              aria-label="发送"
              className="size-7 gap-0 p-0"
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      </div>
      </div>
    </>
  );
}

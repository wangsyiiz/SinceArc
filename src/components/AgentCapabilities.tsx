import { useEffect, useRef, useState } from "react";
import { Check, Minus, Sparkles, Terminal } from "lucide-react";
import type { AgentCommand, AgentProfile } from "@/types";
import { previewCommand } from "@/extensions/registry";
import { cn } from "@/lib/utils";

interface AgentCapabilitiesProps {
  profile: AgentProfile | undefined;
  /** ACP 之外的 CLI 扩展（目前只有 hermes 配了表） */
  commands: AgentCommand[];
}

/**
 * 协议能力键 → 中文说明。
 *
 * 键由后端从 `initialize` 的 `agentCapabilities` 摊平（`acp::capability_keys`），
 * 这里只负责翻译；不认识的键不显示 —— 猜一个能力出来比不显示更糟。
 */
const CAPABILITY_LABEL: Record<string, string> = {
  loadSession: "恢复历史会话",
  image: "图片输入",
  audio: "音频输入",
  embeddedContext: "嵌入上下文",
  list: "会话列表",
  fork: "会话分叉",
  resume: "会话续跑",
  delete: "删除会话",
  mcp: "MCP 服务器",
};

/**
 * 能力面板。两块内容严格分开，因为它们的来源不同：
 *
 * - **协议能力**：来自握手，每个 agent 都有，换 agent 后跟着变；
 * - **ACP 之外的 CLI 扩展**：agent 自己的子命令，目前只有 hermes 配了表。
 *
 * 以前这个按钮只在「有 CLI 扩展」时出现，于是 Codex / Claude 这类 agent 根本没有入口 ——
 * 而它们的协议能力恰恰是用户最想知道的（`capabilities` 为空 = 还没连过，说清楚而不是藏起来）。
 */
export function AgentCapabilities({ profile, commands }: AgentCapabilitiesProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<AgentCommand | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const caps = profile?.capabilities ?? [];
  const rows = Object.entries(CAPABILITY_LABEL).map(([key, label]) => ({
    key,
    label,
    on: caps.includes(key),
  }));
  const supported = rows.filter((r) => r.on).length;

  // 既没有协议能力（还没连过）也没有 CLI 扩展 → 按钮不出现
  if (supported === 0 && commands.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={profile?.agentName ?? undefined}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[11px] transition-colors",
          open ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <Sparkles className="size-3" />
        能力
        <span className="font-mono text-[9px] text-ink-3">{supported}</span>
      </button>

      {open && (
        <div className="sc-glass absolute top-full right-0 z-30 mt-1.5 w-[320px] rounded-[10px] p-1">
          <div className="px-2 py-1.5 text-[9.5px] tracking-wide text-ink-3">
            协议能力（握手报上来的）
          </div>
          <div className="px-1 pb-1">
            {rows.map((r) => (
              <div
                key={r.key}
                className={cn(
                  "flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[11px]",
                  r.on ? "text-ink-1" : "text-ink-3",
                )}
              >
                {r.on ? (
                  <Check className="size-3 shrink-0 text-ok-1" />
                ) : (
                  <Minus className="size-3 shrink-0 text-ink-3/60" />
                )}
                {r.label}
              </div>
            ))}
            {supported === 0 && (
              <p className="px-1.5 py-1 text-[9.5px] leading-relaxed text-ink-3">
                还没连过这个 agent：能力要握手之后才知道。
              </p>
            )}
          </div>

          {commands.length > 0 && (
            <>
              <div className="mt-1 border-t border-line-1/40 px-2 py-1.5 text-[9.5px] tracking-wide text-ink-3">
                ACP 之外的 {commands.length} 项
              </div>
              {commands.map((c) => {
                const active = picked?.id === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setPicked(active ? null : c)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors",
                      active ? "sc-row-active" : "hover:bg-surface-3/45",
                    )}
                  >
                    <Terminal className="mt-[3px] size-3 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11.5px] text-ink-1">{c.label}</span>
                        <span className="shrink-0 font-mono text-[9px] text-ink-3">
                          {c.argv.join(" ")}
                        </span>
                      </span>
                      {c.note && (
                        <span className="mt-0.5 block text-[10px] text-ink-3">{c.note}</span>
                      )}
                    </span>
                  </button>
                );
              })}

              {picked && (
                <div className="mt-1 border-t border-line-1/40 px-2 py-2">
                  <div className="text-[9.5px] text-ink-3">将执行</div>
                  <code className="mt-1 block break-all font-mono text-[10px] leading-relaxed text-ink-2">
                    {previewCommand(profile, picked.argv)}
                  </code>
                  <p className="mt-1.5 text-[9.5px] leading-relaxed text-ink-3">
                    未接线：目前只显示命令形态，不发起调用。
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

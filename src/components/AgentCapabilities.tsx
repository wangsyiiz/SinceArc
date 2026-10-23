import { useEffect, useState } from "react";
import { Sparkles, Terminal } from "lucide-react";
import type { AgentCommand, AgentProfile } from "@/types";
import { commandPreview } from "@/extensions/registry";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/Badge";
import { useAnchoredLayer } from "./ui/Menu";

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
export const CAPABILITY_LABEL: Record<string, string> = {
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
  const [picked, setPicked] = useState<AgentCommand | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const { triggerRef, panelRef, open, toggle, style } = useAnchoredLayer({
    align: "end",
    prefer: "below",
  });

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewFailed(false);
    setPreviewLoading(false);
    if (!open || !picked) {
      return () => {
        alive = false;
      };
    }
    if (!profile) {
      setPreviewFailed(true);
      return () => {
        alive = false;
      };
    }

    setPreviewLoading(true);
    void commandPreview(profile, picked)
      .then((line) => {
        if (alive) setPreview(line);
      })
      .catch(() => {
        if (alive) setPreviewFailed(true);
      })
      .finally(() => {
        if (alive) setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, picked, profile]);

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
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        title={profile?.agentName ?? undefined}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-mark px-2 text-caption transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1",
          open ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <Sparkles className="size-3" />
        能力
        <span className="font-mono text-micro text-ink-3">{supported}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Agent 能力"
          style={style}
          className="sc-glass sc-z-popover w-80 rounded-card p-1"
        >
          <div className="px-2 py-1.5 text-micro tracking-wide text-ink-3">
            协议能力（握手报上来的）
          </div>
          <div className="flex flex-wrap gap-1 px-1 pb-1">
            {rows.map((r) => (
              <Badge
                key={r.key}
                status={r.on ? "connected" : "untested"}
                label={r.label}
                compact
              />
            ))}
            {supported === 0 && (
              <p className="px-1.5 py-1 text-micro text-ink-3">
                还没连过这个 agent：能力要握手之后才知道。
              </p>
            )}
          </div>

          {commands.length > 0 && (
            <>
              <div className="mt-1 border-t border-line-1/40 px-2 py-1.5 text-micro tracking-wide text-ink-3">
                ACP 之外的 {commands.length} 项（预览，未接线）
              </div>
              {commands.map((c) => {
                const active = picked?.id === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setPicked(active ? null : c)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-mark px-2 py-1.5 text-left transition-colors",
                      active ? "sc-row-active" : "hover:bg-surface-3/45",
                    )}
                  >
                    <Terminal className="mt-0.5 size-3 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-ui-tight text-ink-1">{c.label}</span>
                        <span className="shrink-0 font-mono text-micro text-ink-3">
                          {c.argv.join(" ")}
                        </span>
                      </span>
                      {c.note && (
                        <span className="mt-0.5 block text-caption text-ink-3">{c.note}</span>
                      )}
                    </span>
                  </button>
                );
              })}

              {picked && (
                <div className="mt-1 border-t border-line-1/40 px-2 py-2">
                  <div className="text-micro text-ink-3">将执行</div>
                  {previewLoading && (
                    <p className="mt-1 text-caption text-ink-3">正在生成命令预览…</p>
                  )}
                  {previewFailed && (
                    <p className="mt-1 text-caption text-ink-3">无法生成命令预览</p>
                  )}
                  {preview && (
                    <code className="mt-1 block break-all whitespace-pre-wrap font-mono text-caption text-ink-2">
                      {preview}
                    </code>
                  )}
                  <p className="mt-1.5 text-micro text-ink-3">
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
